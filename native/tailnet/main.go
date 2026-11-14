// Command tailnet serves one desktop backend on its own tailnet node.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"tailscale.com/client/tailscale/apitype"
	"tailscale.com/tailcfg"
	"tailscale.com/tsnet"
)

type state struct {
	Phase   string `json:"phase"`
	Value   string `json:"value"`
	Account string `json:"account,omitempty"`
}

func report(phase, value string) {
	json.NewEncoder(os.Stdout).Encode(state{Phase: phase, Value: value})
}

func run() error {
	if len(os.Args) != 3 {
		return errors.New("expected state directory and backend port")
	}
	port, err := strconv.Atoi(os.Args[2])
	if err != nil || port < 1 || port > 65535 {
		return errors.New("invalid backend port")
	}
	server := &tsnet.Server{Dir: os.Args[1], Hostname: "pinacode", UserLogf: func(string, ...any) {}}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	// EOF releases the node even when Electron crashes.
	commands := make(chan string, 1)
	go func() {
		scanner := bufio.NewScanner(os.Stdin)
		for scanner.Scan() {
			commands <- scanner.Text()
		}
		cancel()
	}()
	client, err := server.LocalClient()
	if err != nil {
		return err
	}
	defer server.Close()
	go func() {
		select {
		case <-ctx.Done():
		case command := <-commands:
			if command == "logout" {
				timeout, done := context.WithTimeout(ctx, 10*time.Second)
				defer done()
				if err := client.Logout(timeout); err != nil {
					report("error", err.Error())
				} else {
					report("signed-out", "")
				}
			}
			cancel()
		}
	}()
	lastURL := ""
	for {
		status, err := client.StatusWithoutPeers(ctx)
		if err != nil {
			return err
		}
		if status.BackendState == "Running" && status.Self != nil {
			owner := status.Self.UserID
			address := status.TailscaleIPs
			if len(address) == 0 {
				return errors.New("node has no Tailscale address")
			}
			var listener net.Listener
			var endpoint *url.URL
			if len(status.CertDomains) > 0 && status.CurrentTailnet != nil && status.CurrentTailnet.MagicDNSEnabled {
				listener, err = server.ListenTLS("tcp", ":443")
				endpoint = &url.URL{Scheme: "https", Host: status.CertDomains[0]}
			} else {
				listener, err = server.Listen("tcp", ":80")
				endpoint = &url.URL{Scheme: "http", Host: address[0].String()}
				if address[0].Is6() {
					endpoint.Host = "[" + endpoint.Host + "]"
				}
			}
			if err != nil {
				return err
			}
			defer listener.Close()
			target := &url.URL{Scheme: "http", Host: net.JoinHostPort("127.0.0.1", strconv.Itoa(port))}
			web := &http.Server{ReadHeaderTimeout: 10 * time.Second, Handler: backendProxy(target, endpoint.Host, owner, client.WhoIs)}
			go func() { <-ctx.Done(); web.Close() }()
			json.NewEncoder(os.Stdout).Encode(state{Phase: "connected", Value: endpoint.String(), Account: status.User[owner].LoginName})
			return web.Serve(listener)
		}
		if status.AuthURL != "" && status.AuthURL != lastURL {
			lastURL = status.AuthURL
			report("login", lastURL)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Second):
		}
	}
}

func backendProxy(target *url.URL, host string, owner tailcfg.UserID, whoIs func(context.Context, string) (*apitype.WhoIsResponse, error)) http.Handler {
	proxy := &httputil.ReverseProxy{Rewrite: func(r *httputil.ProxyRequest) {
		r.SetURL(target)
		r.Out.Host = host
		r.SetXForwarded()
	}}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		peer, err := whoIs(r.Context(), r.RemoteAddr)
		if err != nil || owner == 0 || peer == nil || peer.Node == nil || peer.Node.User != owner || peer.Node.IsTagged() {
			http.Error(w, "Tailscale account required", 403)
			return
		}
		if !strings.EqualFold(r.Host, host) {
			http.Error(w, "Invalid host", 400)
			return
		}
		proxy.ServeHTTP(w, r)
	})
}

func main() {
	if err := run(); err != nil && !errors.Is(err, context.Canceled) && !errors.Is(err, http.ErrServerClosed) {
		report("error", err.Error())
		os.Exit(1)
	}
}
