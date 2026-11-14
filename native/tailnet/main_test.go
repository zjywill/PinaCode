package main

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"tailscale.com/client/tailscale/apitype"
	"tailscale.com/tailcfg"
)

func TestBackendProxy(t *testing.T) {
	const host = "pinacode.example.ts.net"
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Host != host || r.Header.Get("X-Forwarded-Proto") != "https" || r.URL.RequestURI() != "/api/status?q=1" {
			t.Error("lost public origin or request path", r.Host, r.Header, r.URL)
		}
		io.WriteString(w, "backend")
	}))
	defer upstream.Close()
	target, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, requestHost string
		node              *tailcfg.Node
		want              int
	}{
		{"owner", host, &tailcfg.Node{User: 1}, 200},
		{"another user", host, &tailcfg.Node{User: 2}, 403},
		{"unknown peer", host, nil, 403},
		{"tagged device", host, &tailcfg.Node{User: 1, Tags: []string{"tag:service"}}, 403},
		{"foreign host", "localhost", &tailcfg.Node{User: 1}, 400},
	} {
		t.Run(tc.name, func(t *testing.T) {
			handler := backendProxy(target, host, 1, func(context.Context, string) (*apitype.WhoIsResponse, error) {
				return &apitype.WhoIsResponse{Node: tc.node}, nil
			})
			req := httptest.NewRequest("GET", "https://"+tc.requestHost+"/api/status?q=1", nil)
			req.Header.Set("X-Forwarded-Proto", "http")
			res := httptest.NewRecorder()
			handler.ServeHTTP(res, req)
			if res.Code != tc.want || (res.Code == 200 && res.Body.String() != "backend") {
				t.Fatalf("response = %d %q", res.Code, res.Body)
			}
		})
	}
}
