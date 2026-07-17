package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/amazon-gamelift/amazon-gamelift-servers-go-server-sdk/v5/model"
	"github.com/amazon-gamelift/amazon-gamelift-servers-go-server-sdk/v5/model/request"
	"github.com/amazon-gamelift/amazon-gamelift-servers-go-server-sdk/v5/model/result"
	"github.com/amazon-gamelift/amazon-gamelift-servers-go-server-sdk/v5/server"
)

type gameLiftAPI interface {
	ActivateGameSession() error
	AcceptPlayerSession(string) error
	RemovePlayerSession(string) error
	DescribePlayerSessions(request.DescribePlayerSessionsRequest) (result.DescribePlayerSessionsResult, error)
	ProcessEnding() error
	GetComputeCertificate() (result.GetComputeCertificateResult, error)
}

type awsGameLiftAPI struct{}

func (awsGameLiftAPI) ActivateGameSession() error          { return server.ActivateGameSession() }
func (awsGameLiftAPI) AcceptPlayerSession(id string) error { return server.AcceptPlayerSession(id) }
func (awsGameLiftAPI) RemovePlayerSession(id string) error { return server.RemovePlayerSession(id) }
func (awsGameLiftAPI) DescribePlayerSessions(value request.DescribePlayerSessionsRequest) (result.DescribePlayerSessionsResult, error) {
	return server.DescribePlayerSessions(value)
}
func (awsGameLiftAPI) ProcessEnding() error { return server.ProcessEnding() }
func (awsGameLiftAPI) GetComputeCertificate() (result.GetComputeCertificateResult, error) {
	return server.GetComputeCertificate()
}

type runtimeState struct {
	mu              sync.RWMutex
	CertificatePath string `json:"certificatePath"`
	ComputeName     string `json:"computeName"`
}

func (s *runtimeState) set(certificate result.GetComputeCertificateResult) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.CertificatePath = certificate.CertificatePath
	s.ComputeName = certificate.ComputeName
}

func (s *runtimeState) snapshot() (string, string) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.CertificatePath, s.ComputeName
}

type sessionState struct {
	mu      sync.RWMutex
	session model.GameSession
	update  *model.UpdateGameSession
}

func (s *sessionState) setSession(value model.GameSession) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.session = value
	s.update = nil
}

func (s *sessionState) setUpdate(value model.UpdateGameSession) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.update = &value
}

func (s *sessionState) snapshot() any {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.update != nil {
		return *s.update
	}
	return s.session
}

func (s *sessionState) gameSessionID() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.update != nil {
		return s.update.GameSession.GameSessionID
	}
	return s.session.GameSessionID
}

type lifecycle struct {
	api            gameLiftAPI
	state          *sessionState
	runtime        *runtimeState
	httpClient     *http.Client
	healthURL      string
	drainURL       string
	drainStatusURL string
	terminating    chan struct{}
	terminate      sync.Once
	ending         sync.Once
	endingErr      error
}

func newLifecycle(api gameLiftAPI, healthURL, drainURL string) *lifecycle {
	return &lifecycle{
		api:            api,
		state:          &sessionState{},
		runtime:        &runtimeState{},
		httpClient:     &http.Client{Timeout: time.Second},
		healthURL:      healthURL,
		drainURL:       drainURL,
		drainStatusURL: drainStatusURL(drainURL),
		terminating:    make(chan struct{}),
	}
}

func (l *lifecycle) onStartGameSession(value model.GameSession) {
	l.state.setSession(value)
	if err := l.api.ActivateGameSession(); err != nil {
		log.Printf("gamelift activate session failed: %v", err)
		l.signalTermination()
		return
	}
	log.Printf("gamelift session activated id=%s", value.GameSessionID)
}

func (l *lifecycle) onUpdateGameSession(value model.UpdateGameSession) {
	l.state.setUpdate(value)
	log.Printf("gamelift session updated id=%s", value.GameSession.GameSessionID)
}

func (l *lifecycle) onHealthCheck() bool {
	request, err := http.NewRequestWithContext(context.Background(), http.MethodGet, l.healthURL, nil)
	if err != nil {
		return false
	}
	response, err := l.httpClient.Do(request)
	if err != nil {
		return false
	}
	defer response.Body.Close()
	return response.StatusCode >= 200 && response.StatusCode < 300
}

func (l *lifecycle) onProcessTerminate() {
	go l.drainAndTerminate()
}

func (l *lifecycle) drainAndTerminate() {
	if l.drainURL == "" || l.drainStatusURL == "" {
		l.signalTermination()
		return
	}
	requestValue, err := http.NewRequestWithContext(context.Background(), http.MethodPost, l.drainURL, nil)
	if err != nil {
		l.signalTermination()
		return
	}
	response, requestErr := l.httpClient.Do(requestValue)
	if requestErr != nil {
		log.Printf("game server drain request failed: %v", requestErr)
		l.signalTermination()
		return
	}
	response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		log.Printf("game server drain request returned status=%d", response.StatusCode)
		l.signalTermination()
		return
	}

	deadline := time.NewTimer(90 * time.Second)
	ticker := time.NewTicker(500 * time.Millisecond)
	defer deadline.Stop()
	defer ticker.Stop()
	for {
		select {
		case <-deadline.C:
			log.Print("game server drain deadline reached; terminating process")
			l.signalTermination()
			return
		case <-ticker.C:
			statusRequest, statusErr := http.NewRequestWithContext(context.Background(), http.MethodGet, l.drainStatusURL, nil)
			if statusErr != nil {
				continue
			}
			statusResponse, statusErr := l.httpClient.Do(statusRequest)
			if statusErr != nil {
				continue
			}
			var status struct {
				Safe bool `json:"safe"`
			}
			decodeErr := json.NewDecoder(statusResponse.Body).Decode(&status)
			statusResponse.Body.Close()
			if decodeErr == nil && statusResponse.StatusCode >= 200 && statusResponse.StatusCode < 300 && status.Safe {
				l.signalTermination()
				return
			}
		}
	}
}

func (l *lifecycle) signalTermination() {
	l.terminate.Do(func() { close(l.terminating) })
}

func (l *lifecycle) endProcess() error {
	l.ending.Do(func() {
		l.endingErr = l.api.ProcessEnding()
		l.signalTermination()
	})
	return l.endingErr
}

type playerSessionRequest struct {
	PlayerSessionID string `json:"playerSessionId"`
}

func (l *lifecycle) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/session", func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(response).Encode(l.state.snapshot()); err != nil {
			http.Error(response, "unable to encode session", http.StatusInternalServerError)
		}
	})
	mux.HandleFunc("GET /v1/runtime", func(response http.ResponseWriter, _ *http.Request) {
		certificatePath, computeName := l.runtime.snapshot()
		if certificatePath == "" || computeName == "" {
			http.Error(response, "runtime certificate unavailable", http.StatusServiceUnavailable)
			return
		}
		response.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(response).Encode(map[string]string{
			"certificatePath": certificatePath,
			"computeName":     computeName,
		})
	})
	mux.HandleFunc("POST /v1/player-sessions/accept", l.acceptPlayerSessionHandler)
	mux.HandleFunc("POST /v1/player-sessions/remove", l.playerSessionHandler(l.api.RemovePlayerSession))
	mux.HandleFunc("POST /v1/process/end", func(response http.ResponseWriter, _ *http.Request) {
		if err := l.endProcess(); err != nil {
			http.Error(response, "unable to end process", http.StatusServiceUnavailable)
			return
		}
		response.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("GET /health", func(response http.ResponseWriter, _ *http.Request) {
		if !l.onHealthCheck() {
			http.Error(response, "game server unhealthy", http.StatusServiceUnavailable)
			return
		}
		response.WriteHeader(http.StatusNoContent)
	})
	return mux
}

func (l *lifecycle) acceptPlayerSessionHandler(response http.ResponseWriter, requestValue *http.Request) {
	playerSessionID, ok := decodePlayerSessionRequest(response, requestValue)
	if !ok {
		return
	}
	describeRequest := request.NewDescribePlayerSessions()
	describeRequest.PlayerSessionID = playerSessionID
	described, err := l.api.DescribePlayerSessions(describeRequest)
	if err != nil || len(described.PlayerSessions) != 1 {
		http.Error(response, "player session rejected", http.StatusUnauthorized)
		return
	}
	playerSession := described.PlayerSessions[0]
	if playerSession.PlayerSessionID != playerSessionID || playerSession.GameSessionID != l.state.gameSessionID() ||
		playerSession.PlayerID == "" || playerSession.Status == nil || playerSession.GetStatus() != model.PlayerReserved {
		http.Error(response, "player session rejected", http.StatusUnauthorized)
		return
	}
	if err := l.api.AcceptPlayerSession(playerSessionID); err != nil {
		http.Error(response, "player session rejected", http.StatusUnauthorized)
		return
	}
	response.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(response).Encode(map[string]string{"playerId": playerSession.PlayerID})
}

func (l *lifecycle) playerSessionHandler(action func(string) error) http.HandlerFunc {
	return func(response http.ResponseWriter, requestValue *http.Request) {
		playerSessionID, ok := decodePlayerSessionRequest(response, requestValue)
		if !ok {
			return
		}
		if err := action(playerSessionID); err != nil {
			http.Error(response, "player session rejected", http.StatusUnauthorized)
			return
		}
		response.WriteHeader(http.StatusNoContent)
	}
}

func decodePlayerSessionRequest(response http.ResponseWriter, requestValue *http.Request) (string, bool) {
	requestValue.Body = http.MaxBytesReader(response, requestValue.Body, 4096)
	var payload playerSessionRequest
	if err := json.NewDecoder(requestValue.Body).Decode(&payload); err != nil || strings.TrimSpace(payload.PlayerSessionID) == "" || len(payload.PlayerSessionID) > 2048 {
		http.Error(response, "playerSessionId is required", http.StatusBadRequest)
		return "", false
	}
	return strings.TrimSpace(payload.PlayerSessionID), true
}

func waitForHealthy(ctx context.Context, client *http.Client, healthURL string) error {
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	for {
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, healthURL, nil)
		if err == nil {
			response, requestErr := client.Do(request)
			if requestErr == nil {
				response.Body.Close()
				if response.StatusCode >= 200 && response.StatusCode < 300 {
					return nil
				}
			}
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("game server did not become healthy: %w", ctx.Err())
		case <-ticker.C:
		}
	}
}

func envInt(name string, fallback int) (int, error) {
	value := os.Getenv(name)
	if value == "" {
		return fallback, nil
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed < 1 || parsed > 60000 {
		return 0, fmt.Errorf("%s must be a valid port", name)
	}
	return parsed, nil
}

func run() error {
	gamePort, err := envInt("GAME_PORT", 8080)
	if err != nil {
		return err
	}
	internalPort, err := envInt("GAMELIFT_ADAPTER_PORT", 8090)
	if err != nil {
		return err
	}
	healthURL := envOr("GAME_HEALTH_URL", fmt.Sprintf("http://127.0.0.1:%d/api/health", gamePort))
	drainURL := envOr("GAME_DRAIN_URL", fmt.Sprintf("http://127.0.0.1:%d/api/gamelift/drain", gamePort))

	api := awsGameLiftAPI{}
	process := newLifecycle(api, healthURL, drainURL)
	internalServer := &http.Server{
		Addr:              fmt.Sprintf("127.0.0.1:%d", internalPort),
		Handler:           process.handler(),
		ReadHeaderTimeout: 2 * time.Second,
	}
	go func() {
		if serveErr := internalServer.ListenAndServe(); serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			log.Printf("adapter HTTP server failed: %v", serveErr)
			process.signalTermination()
		}
	}()

	if err := server.InitSDKFromEnvironment(); err != nil {
		return fmt.Errorf("initialize GameLift SDK: %w", err)
	}
	defer server.Destroy()
	certificate, certificateErr := api.GetComputeCertificate()
	requireTLS := strings.EqualFold(os.Getenv("REQUIRE_GAMELIFT_TLS"), "true")
	if certificateErr != nil || certificate.CertificatePath == "" || certificate.ComputeName == "" {
		if requireTLS {
			if certificateErr != nil {
				return fmt.Errorf("retrieve required GameLift TLS certificate: %w", certificateErr)
			}
			return errors.New("retrieve required GameLift TLS certificate: incomplete certificate response")
		}
		log.Printf("GameLift TLS certificate unavailable; continuing with configured health endpoint: %v", certificateErr)
	} else {
		process.runtime.set(certificate)
		if requireTLS {
			// The Node process exposes TLS only. Keep lifecycle traffic on loopback,
			// while verifying the generated certificate against its GameLift DNS name.
			process.httpClient.Transport = &http.Transport{TLSClientConfig: &tls.Config{
				MinVersion: tls.VersionTLS12,
				ServerName: certificate.ComputeName,
			}}
			if os.Getenv("GAME_HEALTH_URL") == "" {
				process.healthURL = fmt.Sprintf("https://127.0.0.1:%d/api/health", gamePort)
			}
			if os.Getenv("GAME_DRAIN_URL") == "" {
				process.drainURL = fmt.Sprintf("https://127.0.0.1:%d/api/gamelift/drain", gamePort)
				process.drainStatusURL = drainStatusURL(process.drainURL)
			}
		}
	}
	healthContext, cancelHealth := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancelHealth()
	if err := waitForHealthy(healthContext, process.httpClient, process.healthURL); err != nil {
		return err
	}
	if err := server.ProcessReady(server.ProcessParameters{
		OnStartGameSession:  process.onStartGameSession,
		OnUpdateGameSession: process.onUpdateGameSession,
		OnProcessTerminate:  process.onProcessTerminate,
		OnHealthCheck:       process.onHealthCheck,
		Port:                gamePort,
	}); err != nil {
		return fmt.Errorf("register GameLift process: %w", err)
	}

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	select {
	case received := <-signals:
		log.Printf("received signal=%s", received)
	case <-process.terminating:
		log.Print("received GameLift termination request")
	}

	shutdownContext, cancelShutdown := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelShutdown()
	_ = internalServer.Shutdown(shutdownContext)
	if err := process.endProcess(); err != nil {
		return fmt.Errorf("notify GameLift process ending: %w", err)
	}
	return nil
}

func envOr(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func drainStatusURL(drainURL string) string {
	if drainURL == "" {
		return ""
	}
	return strings.TrimSuffix(drainURL, "/drain") + "/drain-status"
}

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}
