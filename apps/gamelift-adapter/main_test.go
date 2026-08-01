package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/amazon-gamelift/amazon-gamelift-servers-go-server-sdk/v5/model"
	"github.com/amazon-gamelift/amazon-gamelift-servers-go-server-sdk/v5/model/request"
	"github.com/amazon-gamelift/amazon-gamelift-servers-go-server-sdk/v5/model/result"
)

type fakeGameLift struct {
	activated     bool
	activatedCh   chan struct{}
	accepted      []string
	removed       []string
	described     *model.PlayerSession
	err           error
	removeErr     error
	acceptEntered chan struct{}
	acceptGate    chan struct{}
	removeEntered chan struct{}
	acceptOnce    sync.Once
	removeOnce    sync.Once
}

func (f *fakeGameLift) ActivateGameSession() error {
	f.activated = true
	if f.activatedCh != nil {
		close(f.activatedCh)
	}
	return f.err
}
func (f *fakeGameLift) AcceptPlayerSession(id string) error {
	if f.acceptEntered != nil {
		f.acceptOnce.Do(func() { close(f.acceptEntered) })
	}
	if f.acceptGate != nil {
		<-f.acceptGate
	}
	f.accepted = append(f.accepted, id)
	return f.err
}
func (f *fakeGameLift) RemovePlayerSession(id string) error {
	if f.removeEntered != nil {
		f.removeOnce.Do(func() { close(f.removeEntered) })
	}
	f.removed = append(f.removed, id)
	if f.removeErr != nil {
		return f.removeErr
	}
	return f.err
}
func (f *fakeGameLift) DescribePlayerSessions(value request.DescribePlayerSessionsRequest) (result.DescribePlayerSessionsResult, error) {
	if f.err != nil {
		return result.DescribePlayerSessionsResult{}, f.err
	}
	if f.described != nil {
		return result.DescribePlayerSessionsResult{PlayerSessions: []model.PlayerSession{*f.described}}, nil
	}
	return result.DescribePlayerSessionsResult{PlayerSessions: []model.PlayerSession{
		(model.PlayerSession{
			PlayerSessionID: value.PlayerSessionID,
			PlayerID:        "player-1",
			GameSessionID:   "session-1",
		}).WithStatus(model.PlayerReserved),
	}}, nil
}

func TestPlayerSessionMustBelongToCurrentGameSession(t *testing.T) {
	wrongSession := (model.PlayerSession{
		PlayerSessionID: "player-session-1",
		PlayerID:        "player-1",
		GameSessionID:   "different-session",
	}).WithStatus(model.PlayerReserved)
	fake := &fakeGameLift{described: &wrongSession}
	process := newLifecycle(fake, "http://unused", "")
	process.state.setSession(model.GameSession{GameSessionID: "session-1"})
	requestValue := httptest.NewRequest(http.MethodPost, "/v1/player-sessions/accept", strings.NewReader(`{"playerSessionId":"player-session-1"}`))
	response := httptest.NewRecorder()
	process.handler().ServeHTTP(response, requestValue)
	if response.Code != http.StatusUnauthorized || len(fake.accepted) != 0 {
		t.Fatalf("unexpected admission result status=%d accepted=%#v", response.Code, fake.accepted)
	}
}

func TestAcceptedPlayerSessionReturnsTrustedPlayerData(t *testing.T) {
	described := (model.PlayerSession{
		PlayerSessionID: "player-session-1",
		PlayerID:        "player-1",
		PlayerData:      `{"mode":"public-hot-arena","arenaId":"H0T1"}`,
		GameSessionID:   "session-1",
	}).WithStatus(model.PlayerReserved)
	fake := &fakeGameLift{described: &described}
	process := newLifecycle(fake, "http://unused", "")
	process.state.setSession(model.GameSession{GameSessionID: "session-1"})
	requestValue := httptest.NewRequest(http.MethodPost, "/v1/player-sessions/accept", strings.NewReader(`{"playerSessionId":"player-session-1"}`))
	response := httptest.NewRecorder()

	process.handler().ServeHTTP(response, requestValue)

	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"playerData"`) || !strings.Contains(response.Body.String(), `public-hot-arena`) {
		t.Fatalf("unexpected admission response status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestSessionEndpointKeepsGameSessionShapeAfterUpdate(t *testing.T) {
	process := newLifecycle(&fakeGameLift{}, "http://unused", "")
	process.state.setSession(model.GameSession{GameSessionID: "session-old"})
	process.onUpdateGameSession(model.UpdateGameSession{
		GameSession: model.GameSession{GameSessionID: "session-updated"},
	})
	requestValue := httptest.NewRequest(http.MethodGet, "/v1/session", nil)
	response := httptest.NewRecorder()

	process.handler().ServeHTTP(response, requestValue)

	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"GameSessionId":"session-updated"`) {
		t.Fatalf("unexpected updated session response status=%d body=%s", response.Code, response.Body.String())
	}
	if strings.Contains(response.Body.String(), `"GameSession":`) {
		t.Fatalf("adapter leaked nested update envelope: %s", response.Body.String())
	}
}

func (f *fakeGameLift) ProcessEnding() error { return f.err }
func (f *fakeGameLift) GetComputeCertificate() (result.GetComputeCertificateResult, error) {
	return result.GetComputeCertificateResult{CertificatePath: "/certs", ComputeName: "compute.example"}, f.err
}

func TestStartSessionStoresBeforeActivation(t *testing.T) {
	fake := &fakeGameLift{}
	process := newLifecycle(fake, "http://unused", "")
	process.markServingReady()
	process.onStartGameSession(model.GameSession{GameSessionID: "session-1"})
	if !fake.activated {
		t.Fatal("expected GameLift activation")
	}
	snapshot := process.state.snapshot().(model.GameSession)
	if snapshot.GameSessionID != "session-1" {
		t.Fatalf("unexpected session id %q", snapshot.GameSessionID)
	}
}

func TestStartSessionWaitsForServingReadiness(t *testing.T) {
	fake := &fakeGameLift{activatedCh: make(chan struct{})}
	process := newLifecycle(fake, "http://unused", "")
	process.onStartGameSession(model.GameSession{GameSessionID: "session-1"})
	select {
	case <-fake.activatedCh:
		t.Fatal("activated before the game server was serving")
	default:
	}
	process.markServingReady()
	select {
	case <-fake.activatedCh:
	case <-time.After(time.Second):
		t.Fatal("session was not activated after serving readiness")
	}
}

func TestPlayerSessionEndpoints(t *testing.T) {
	fake := &fakeGameLift{}
	process := newLifecycle(fake, "http://unused", "")
	process.state.setSession(model.GameSession{GameSessionID: "session-1"})
	request := httptest.NewRequest(http.MethodPost, "/v1/player-sessions/accept", strings.NewReader(`{"playerSessionId":"player-session-1"}`))
	response := httptest.NewRecorder()
	process.handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"playerId":"player-1"`) {
		t.Fatalf("unexpected status %d", response.Code)
	}
	if len(fake.accepted) != 1 || fake.accepted[0] != "player-session-1" {
		t.Fatalf("unexpected accepted sessions %#v", fake.accepted)
	}
}

func TestRemovalReconcilesAlreadyTerminalSession(t *testing.T) {
	for name, described := range map[string]model.PlayerSession{
		"completed": (model.PlayerSession{
			PlayerSessionID: "player-session-1",
			PlayerID:        "player-1",
			GameSessionID:   "session-1",
		}).WithStatus(model.PlayerCompleted),
		"timedout": (model.PlayerSession{
			PlayerSessionID: "player-session-1",
			PlayerID:        "player-1",
			GameSessionID:   "session-1",
		}).WithStatus(model.PlayerTimedout),
	} {
		t.Run(name, func(t *testing.T) {
			fake := &fakeGameLift{described: &described, removeErr: errors.New("already non-active")}
			process := newLifecycle(fake, "http://unused", "")
			process.state.setSession(model.GameSession{GameSessionID: "session-1"})
			requestValue := httptest.NewRequest(http.MethodPost, "/v1/player-sessions/remove", strings.NewReader(`{"playerSessionId":"player-session-1"}`))
			response := httptest.NewRecorder()

			process.handler().ServeHTTP(response, requestValue)

			if response.Code != http.StatusNoContent || len(fake.removed) != 1 {
				t.Fatalf("unexpected reconciled removal status=%d removed=%#v", response.Code, fake.removed)
			}
		})
	}
}

func TestRemovalDoesNotMaskAReservedSessionFailure(t *testing.T) {
	described := (model.PlayerSession{
		PlayerSessionID: "player-session-1",
		PlayerID:        "player-1",
		GameSessionID:   "session-1",
	}).WithStatus(model.PlayerReserved)
	fake := &fakeGameLift{described: &described, removeErr: errors.New("remove failed")}
	process := newLifecycle(fake, "http://unused", "")
	process.state.setSession(model.GameSession{GameSessionID: "session-1"})
	requestValue := httptest.NewRequest(http.MethodPost, "/v1/player-sessions/remove", strings.NewReader(`{"playerSessionId":"player-session-1"}`))
	response := httptest.NewRecorder()

	process.handler().ServeHTTP(response, requestValue)

	if response.Code != http.StatusUnauthorized {
		t.Fatalf("reserved removal failure was masked with status=%d", response.Code)
	}
}

func TestAcceptAndRemoveAreSerializedForTheSamePlayerSession(t *testing.T) {
	fake := &fakeGameLift{
		acceptEntered: make(chan struct{}),
		acceptGate:    make(chan struct{}),
		removeEntered: make(chan struct{}),
	}
	process := newLifecycle(fake, "http://unused", "")
	process.state.setSession(model.GameSession{GameSessionID: "session-1"})
	handler := process.handler()
	acceptDone := make(chan int, 1)
	go func() {
		requestValue := httptest.NewRequest(http.MethodPost, "/v1/player-sessions/accept", strings.NewReader(`{"playerSessionId":"player-session-1"}`))
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, requestValue)
		acceptDone <- response.Code
	}()
	<-fake.acceptEntered
	removeDone := make(chan int, 1)
	go func() {
		requestValue := httptest.NewRequest(http.MethodPost, "/v1/player-sessions/remove", strings.NewReader(`{"playerSessionId":"player-session-1"}`))
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, requestValue)
		removeDone <- response.Code
	}()

	select {
	case <-fake.removeEntered:
		t.Fatal("remove overtook an in-flight accept for the same player session")
	case <-time.After(25 * time.Millisecond):
	}
	close(fake.acceptGate)
	if status := <-acceptDone; status != http.StatusOK {
		t.Fatalf("unexpected accept status=%d", status)
	}
	if status := <-removeDone; status != http.StatusNoContent {
		t.Fatalf("unexpected removal status=%d", status)
	}
}

func TestRemovalDoesNotMaskAnActiveOrForeignSessionFailure(t *testing.T) {
	for name, described := range map[string]model.PlayerSession{
		"active": (model.PlayerSession{
			PlayerSessionID: "player-session-1",
			PlayerID:        "player-1",
			GameSessionID:   "session-1",
		}).WithStatus(model.PlayerActive),
		"foreign": (model.PlayerSession{
			PlayerSessionID: "player-session-1",
			PlayerID:        "player-1",
			GameSessionID:   "session-foreign",
		}).WithStatus(model.PlayerCompleted),
	} {
		t.Run(name, func(t *testing.T) {
			fake := &fakeGameLift{described: &described, removeErr: errors.New("remove failed")}
			process := newLifecycle(fake, "http://unused", "")
			process.state.setSession(model.GameSession{GameSessionID: "session-1"})
			requestValue := httptest.NewRequest(http.MethodPost, "/v1/player-sessions/remove", strings.NewReader(`{"playerSessionId":"player-session-1"}`))
			response := httptest.NewRecorder()

			process.handler().ServeHTTP(response, requestValue)

			if response.Code != http.StatusUnauthorized {
				t.Fatalf("unexpected failed removal status=%d", response.Code)
			}
		})
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
	process.markServingReady()
	if !process.onHealthCheck() {
		t.Fatal("expected healthy game server")
	}
}

func TestBootstrapHealthDoesNotRaceTLSServerStartup(t *testing.T) {
	process := newLifecycle(&fakeGameLift{}, "http://127.0.0.1:1/api/health", "")
	if !process.onHealthCheck() {
		t.Fatal("expected the registered process to remain healthy during TLS bootstrap")
	}

	process.markServingReady()
	if process.onHealthCheck() {
		t.Fatal("expected deep health to fail after the serving gate opens")
	}

	process.signalTermination()
	if process.onHealthCheck() {
		t.Fatal("expected a terminating process to report unhealthy")
	}
}

func TestTerminationWaitsUntilGameServerReportsSafeDrain(t *testing.T) {
	var statusChecks int
	game := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, requestValue *http.Request) {
		switch {
		case requestValue.Method == http.MethodPost && requestValue.URL.Path == "/api/gamelift/drain":
			response.WriteHeader(http.StatusNoContent)
		case requestValue.Method == http.MethodGet && requestValue.URL.Path == "/api/gamelift/drain-status":
			statusChecks++
			_ = json.NewEncoder(response).Encode(map[string]bool{"safe": statusChecks >= 2})
		default:
			http.NotFound(response, requestValue)
		}
	}))
	defer game.Close()
	process := newLifecycle(&fakeGameLift{}, "http://unused", game.URL+"/api/gamelift/drain")
	process.onProcessTerminate()
	select {
	case <-process.terminating:
		if statusChecks < 2 {
			t.Fatalf("terminated before safe drain status: checks=%d", statusChecks)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for safe drain")
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
