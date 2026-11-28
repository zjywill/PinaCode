import {
  CommandId,
  ProjectId,
  type RepositoryIdentity,
  type SourceControlEnsureRepositoryProjectResult,
  type SourceControlRepositoryError,
} from "@t3tools/contracts";
import { cloneUrlRepositoryPath, withoutRemoteUrlCredentials } from "@t3tools/shared/cloneUrl";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import { newProjectFolderName } from "@t3tools/shared/path";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Repositories from "../sourceControl/SourceControlRepositoryService.ts";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";
import * as ManagedProjectFolders from "./ManagedProjectFolders.ts";
import * as Projects from "./ProjectService.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";

export class RepositoryProjectInputError extends Schema.TaggedError<RepositoryProjectInputError>()(
  "RepositoryProjectInputError",
  {},
) {
  override get message() {
    return "Enter an HTTP(S) or SSH repository clone URL without credentials, query parameters or a fragment.";
  }
}

export class RepositoryProjectDestinationError extends Schema.TaggedError<RepositoryProjectDestinationError>()(
  "RepositoryProjectDestinationError",
  {},
) {
  override get message() {
    return "The managed destination is occupied by a different folder. No project was created.";
  }
}

export class RepositoryProjectSetupError extends Schema.TaggedError<RepositoryProjectSetupError>()(
  "RepositoryProjectSetupError",
  {
    stage: Schema.Literals(["resolve", "checkout", "register"]),
    cause: Schema.Defect(),
  },
) {
  override get message() {
    switch (this.stage) {
      case "resolve":
        return "The environment could not check its existing projects.";
      case "checkout":
        return "The environment could not prepare the checkout. No project was registered.";
      case "register":
        return "The checkout is ready, but the environment could not register it. Retry with the same repository URL.";
    }
  }
}

export class RepositoryProjectSetup extends Context.Service<
  RepositoryProjectSetup,
  {
    readonly ensure: (
      remoteUrl: string,
    ) => Effect.Effect<
      SourceControlEnsureRepositoryProjectResult,
      | RepositoryProjectInputError
      | RepositoryProjectDestinationError
      | RepositoryProjectSetupError
      | SourceControlRepositoryError
    >;
  }
>()("pinacode/project/RepositoryProjectSetup") {}

const checkoutKey = (identity: RepositoryIdentity | null | undefined) =>
  identity?.origin?.canonicalKey ?? identity?.canonicalKey;

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const digest = yield* Digest.Digest;
  const random = yield* SecureRandom.SecureRandom;
  const projects = yield* Projects.ProjectService;
  const repositories = yield* Repositories.SourceControlRepositoryService;
  const identities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const { namedProjectsRoot } = yield* ManagedProjectFolders.ManagedProjectFolders;
  const lock = yield* KeyedLock.make<string>();

  const findProject = Effect.fn("RepositoryProjectSetup.findProject")(function* (key: string) {
    let cursor: number | null = 0;
    while (cursor !== null) {
      const page: Effect.Success<ReturnType<typeof projects.listPage>> = yield* projects.listPage({
        cursor,
        limit: 100,
      });
      const match = page.projects.find(
        (project) => checkoutKey(project.repositoryIdentity) === key,
      );
      if (match) return match;
      cursor = page.nextCursor;
    }
    return null;
  });

  const ensure = Effect.fn("RepositoryProjectSetup.ensure")(function* (remoteUrl: string) {
    const repositoryPath = cloneUrlRepositoryPath(remoteUrl);
    if (
      repositoryPath === null ||
      /[?#\p{Cc}]/u.test(remoteUrl) ||
      withoutRemoteUrlCredentials(remoteUrl) !== remoteUrl ||
      /^ssh:\/\/[^/]*:[^/]*@/i.test(remoteUrl)
    ) {
      return yield* new RepositoryProjectInputError();
    }
    const key = sourceControlDefinitions.repositoryKeyFromRemote(remoteUrl);
    const title = repositoryPath.split("/").at(-1)!;
    const keyName = newProjectFolderName(key.split("/").at(-1) ?? title);
    const checkoutError = (cause: unknown) =>
      new RepositoryProjectSetupError({ stage: "checkout", cause });
    const suffix = yield* digest
      .digest(Digest.sha256, new TextEncoder().encode(key))
      .pipe(Effect.map(Hex.encode), Effect.mapError(checkoutError));
    const workspaceRoot = path.join(namedProjectsRoot, `${keyName}-${suffix.slice(0, 16)}`);

    return yield* lock.withLock(
      key,
      Effect.gen(function* () {
        const existing = yield* findProject(key).pipe(
          Effect.mapError((cause) => new RepositoryProjectSetupError({ stage: "resolve", cause })),
        );
        if (existing) {
          return {
            projectId: existing.id,
            title: existing.title,
            workspaceRoot: existing.workspaceRoot,
            created: false,
          };
        }
        if (yield* fs.exists(workspaceRoot).pipe(Effect.mapError(checkoutError))) {
          const realRoot = yield* fs.realPath(workspaceRoot).pipe(Effect.mapError(checkoutError));
          const identity = yield* identities.resolve(realRoot, { refresh: true });
          if (identity?.rootPath !== realRoot || checkoutKey(identity) !== key) {
            return yield* new RepositoryProjectDestinationError();
          }
        } else {
          yield* fs
            .makeDirectory(namedProjectsRoot, { recursive: true })
            .pipe(Effect.mapError(checkoutError));
          yield* Effect.gen(function* () {
            const stage = yield* fs
              .makeTempDirectoryScoped({ directory: namedProjectsRoot, prefix: ".clone-" })
              .pipe(Effect.mapError(checkoutError));
            yield* repositories.cloneRepository({ remoteUrl, destinationPath: stage });
            // Git can leave a checkout after failing. Publish the folder only on success.
            if (yield* fs.exists(workspaceRoot).pipe(Effect.mapError(checkoutError))) {
              return yield* new RepositoryProjectDestinationError();
            }
            yield* fs.rename(stage, workspaceRoot).pipe(Effect.mapError(checkoutError));
          }).pipe(Effect.scoped);
        }
        const id = yield* random
          .uuidV4()
          .pipe(
            Effect.mapError(
              (cause) => new RepositoryProjectSetupError({ stage: "register", cause }),
            ),
          );
        const { project, created } = yield* projects
          .bootstrap({
            commandId: CommandId.make(`repository-project:${id}`),
            projectId: ProjectId.make(id),
            title,
            workspaceRoot,
          })
          .pipe(
            Effect.mapError(
              (cause) => new RepositoryProjectSetupError({ stage: "register", cause }),
            ),
          );
        return {
          projectId: project.id,
          title: project.title,
          workspaceRoot: project.workspaceRoot,
          created,
        };
      }),
    );
  });

  return RepositoryProjectSetup.of({ ensure });
});

export const layer = Layer.effect(RepositoryProjectSetup, make);
