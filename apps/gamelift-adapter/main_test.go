package main

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/amazon-gamelift/amazon-gamelift-servers-go-server-sdk/v5/model"
	"github.com/amazon-gamelift/amazon-gamelift-servers-go-server-sdk/v5/model/result"
)

type fakeGameLift struct {
	activated bool
	accepted  []string
	removed   []string
	err       error
}

func (f *fakeGameLift) ActivateGameSession() error {
	f.activated = true
	return f.err
}
func (f *fakeGameLift) AcceptPlayerSession(id string) error {
	f.accepted = append(f.accepted, id)
	return f.err
}
func (f *fakeGameLift) RemovePlayerSession(id string) error {
	f.removed = append(f.removed, id)
	return f.err
}
func (f *fakeGameLift) ProcessEnding() error { return f.err }
func (f *fakeGameLift) GetComputeCertificate() (result.GetComputeCertificateResult, error) {
	return result.GetComputeCertificateResult{CertificatePath: "/certs", ComputeName: "compute.example"}, f.err
}

func TestStartSessionStoresBeforeActivation(t *testing.T) {
	fake := &fakeGameLift{}
	process := newLifecycle(fake, "http://unused", "")
	process.onStartGameSession(model.GameSession{GameSessionID: "session-1"})
	if !fake.activated {
		t.Fatal("expected GameLift activation")
	}
	snapshot := process.state.snapshot().(model.GameSession)
	if snapshot.GameSessionID != "session-1" {
		t.Fatalf("unexpected session id %q", snapshot.GameSessionID)
	}
}

func TestPlayerSessionEndpoints(t *testing.T) {
	fake := &fakeGameLift{}
	process := newLifecycle(fake, "http://unused", "")
	request := httptest.NewRequest(http.MethodPost, "/v1/player-sessions/accept", strings.NewReader(`{"playerSessionId":"player-session-1"}`))
	response := httptest.NewRecorder()
	process.handler().ServeHTTP(response, request)
	if response.Code != http.StatusNoContent {
		t.Fatalf("unexpected status %d", response.Code)
	}
	if len(fake.accepted) != 1 || fake.accepted[0] != "player-session-1" {
		t.Fatalf("unexpected accepted sessions %#v", fake.accepted)
	}
}

func TestPlayerSessionRejectionDoesNotLeakSDKError(t *testing.T) {
	fake := &fakeGameLift{err: errors.New("sensitive internal failure")}
	process := newLifecycle(fake, "http://unused", "")
	request := httptest.NewRequest(http.MethodPost, "/v1/player-sessions/accept", strings.NewReader(`{"playerSessionId":"bad"}`))
	response := httptest.NewRecorder()
	process.handler().ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("unexpected status %d", response.Code)
	}
	if strings.Contains(response.Body.String(), "sensitive") {
		t.Fatal("SDK error leaked to caller")
	}
}

func TestDeepHealth(t *testing.T) {
	game := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusOK)
	}))
	defer game.Close()
	process := newLifecycle(&fakeGameLift{}, game.URL, "")
	if !process.onHealthCheck() {
		t.Fatal("expected healthy game server")
	}
}

func TestRuntimeAndProcessEndEndpoints(t *testing.T) {
	fake := &fakeGameLift{}
	process := newLifecycle(fake, "http://unused", "")
	process.runtime.set(result.GetComputeCertificateResult{CertificatePath: "/certs", ComputeName: "compute.example"})

	runtimeRequest := httptest.NewRequest(http.MethodGet, "/v1/runtime", nil)
	runtimeResponse := httptest.NewRecorder()
	process.handler().ServeHTTP(runtimeResponse, runtimeRequest)
	if runtimeResponse.Code != http.StatusOK || !strings.Contains(runtimeResponse.Body.String(), "/certs") {
		t.Fatalf("unexpected runtime response %d %s", runtimeResponse.Code, runtimeResponse.Body.String())
	}

	endRequest := httptest.NewRequest(http.MethodPost, "/v1/process/end", nil)
	endResponse := httptest.NewRecorder()
	process.handler().ServeHTTP(endResponse, endRequest)
	if endResponse.Code != http.StatusNoContent {
		t.Fatalf("unexpected end response %d", endResponse.Code)
	}
}

func TestEnvIntRejectsInvalidPorts(t *testing.T) {
	t.Setenv("TEST_PORT", "70000")
	if _, err := envInt("TEST_PORT", 8080); err == nil {
		t.Fatal("expected invalid port error")
	}
}
