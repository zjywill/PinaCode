import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProjectId,
  type Project,
  type RepositoryIdentity,
  SourceControlProviderKind,
  SourceControlRepositoryError,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as SourceControlRepositoryService from "../sourceControl/SourceControlRepositoryService.ts";
import * as ManagedProjectFolders from "./ManagedProjectFolders.ts";
import * as ProjectService from "./ProjectService.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";
import * as RepositoryProjectSetup from "./RepositoryProjectSetup.ts";

const remoteUrl = "https://github.com/acme/app";
const sshUrl = "git@github.com:acme/app.git";

const identity = (workspaceRoot: string): RepositoryIdentity => ({
  canonicalKey: "github.com/acme/app",
  locator: { source: "git-remote", remoteName: "origin", remoteUrl },
  rootPath: workspaceRoot,
});

it.effect("cleans a failed clone and reuses the completed checkout after registration fails", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped();
    const cloneAttempts = yield* Ref.make(0);
    const registrationAttempts = yield* Ref.make(0);
    const stored = yield* Ref.make<ReadonlyArray<Project>>([]);
    const layer = RepositoryProjectSetup.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: root }),
          Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({
            cloneRepository: Effect.fnUntraced(function* ({ destinationPath }) {
              const attempt = yield* Ref.getAndUpdate(cloneAttempts, (n) => n + 1);
              yield* fs
                .writeFileString(path.join(destinationPath, "checkout"), "fixture")
                .pipe(Effect.orDie);
              if (attempt === 0) {
                return yield* new SourceControlRepositoryError({
                  operation: "cloneRepository",
                  provider: SourceControlProviderKind.make("github"),
                  detail: "Authentication failed.",
                });
              }
              return { cwd: destinationPath, remoteUrl, repository: null };
            }),
          }),
          Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
            resolve: (workspaceRoot) =>
              fs.exists(path.join(workspaceRoot, "checkout")).pipe(
                Effect.map((exists) => (exists ? identity(workspaceRoot) : null)),
                Effect.orDie,
              ),
          }),
          Layer.mock(ProjectService.ProjectService)({
            listPage: () =>
              Effect.map(Ref.get(stored), (projects) => ({ projects, nextCursor: null })),
            bootstrap: Effect.fnUntraced(function* ({ projectId, workspaceRoot, title }) {
              const attempt = yield* Ref.getAndUpdate(registrationAttempts, (n) => n + 1);
              if (attempt === 0) {
                return yield* new ProjectService.ProjectOperationError({
                  operation: "dispatch-project-command",
                  cause: new Error("Registration unavailable"),
                });
              }
              const project = {
                id: projectId,
                workspaceRoot,
                title,
                repositoryIdentity: identity(workspaceRoot),
                defaultModelSelection: null,
                scripts: [],
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
                deletedAt: null,
              } satisfies Project;
              yield* Ref.set(stored, [project]);
              return { project, created: true };
            }),
          }),
        ),
      ),
    );

    const run = (url: string) =>
      RepositoryProjectSetup.RepositoryProjectSetup.pipe(
        Effect.flatMap((service) => service.ensure(url)),
      );
    yield* Effect.gen(function* () {
      expect(yield* run(remoteUrl).pipe(Effect.flip)).toMatchObject({
        _tag: "SourceControlRepositoryError",
        detail: "Authentication failed.",
      });
      expect(yield* fs.readDirectory(root)).toEqual([]);
      expect(yield* Ref.get(registrationAttempts)).toBe(0);

      expect(yield* run(remoteUrl).pipe(Effect.flip)).toMatchObject({
        _tag: "RepositoryProjectSetupError",
        stage: "register",
      });
      expect(yield* Ref.get(stored)).toEqual([]);

      const results = yield* Effect.all([run(sshUrl), run(remoteUrl)], { concurrency: 2 });
      expect(new Set(results.map((result) => result.projectId)).size).toBe(1);
      expect(results.map((result) => result.created).sort()).toEqual([false, true]);
      expect(yield* Ref.get(cloneAttempts)).toBe(2);
      expect(yield* Ref.get(stored)).toHaveLength(1);
      expect(yield* fs.readDirectory(root)).toEqual([path.basename(results[0].workspaceRoot)]);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("reuses a registered checkout outside the managed folder", () =>
  Effect.gen(function* () {
    const workspaceRoot = "/home/user/already-cloned";
    const project = {
      id: ProjectId.make("existing-app"),
      title: "My app",
      workspaceRoot,
      repositoryIdentity: identity(workspaceRoot),
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      deletedAt: null,
    } satisfies Project;
    const setup = yield* RepositoryProjectSetup.RepositoryProjectSetup.pipe(
      Effect.provide(
        RepositoryProjectSetup.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
                namedProjectsRoot: "/home/user/projects",
              }),
              Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({}),
              Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({}),
              Layer.mock(ProjectService.ProjectService)({
                listPage: () => Effect.succeed({ projects: [project], nextCursor: null }),
              }),
            ),
          ),
        ),
      ),
    );
    expect(yield* setup.ensure(sshUrl)).toEqual({
      projectId: project.id,
      title: project.title,
      workspaceRoot,
      created: false,
    });
    expect(yield* setup.ensure("file:///home/user/private").pipe(Effect.flip)).toMatchObject({
      _tag: "RepositoryProjectInputError",
    });
    expect(
      yield* setup.ensure("https://user:password@github.com/acme/app").pipe(Effect.flip),
    ).toMatchObject({ _tag: "RepositoryProjectInputError" });
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);
