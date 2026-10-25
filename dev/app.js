
"use strict";

const API_BASE =
  window.location.hostname === "localhost" ||
  window.location.hostname === "127.0.0.1"
    ? "http://127.0.0.1:8000"
    : "https://wbpszbiq97.execute-api.ap-south-1.amazonaws.com";
const $ = (id) => document.getElementById(id);

const state = {
  memories: [],
  recognition: null,
  isRecording: false,
  finalTranscript: "",
  toastTimer: null,
  csrfToken: null,
  authenticated: false,
  authCheckInProgress: false,
};

// ---------- Notifications ----------
function showToast(message, type = "info") {
  const toast = $("toast");
  toast.textContent = message;
  toast.className = `toast show ${type}`;

  if (state.toastTimer) clearTimeout(state.toastTimer);

  state.toastTimer = setTimeout(() => {
    toast.className = "toast";
  }, 4000);
}

// ---------- Authentication UI ----------
function showLogin(message = "") {
  state.authenticated = false;
  state.csrfToken = null;

  $("app-shell").hidden = true;
  $("login-screen").hidden = false;
  $("login-error").textContent = message;

  if (state.recognition) {
    try {
      state.recognition.abort();
    } catch (_) {
      // Already stopped.
    }

    state.recognition = null;
    state.isRecording = false;
  }
}

function showDashboard(username, csrfToken) {
  state.authenticated = true;
  state.csrfToken = csrfToken || null;

  $("login-screen").hidden = true;
  $("app-shell").hidden = false;
  $("logged-in-user").textContent = username || "admin";
  $("login-error").textContent = "";
}

// ---------- API requests ----------
async function apiRequest(path, options = {}) {
  const requestOptions = { ...options };
  const method = (requestOptions.method || "GET").toUpperCase();
  const headers = new Headers(requestOptions.headers || {});

  requestOptions.credentials = "include";

  const token = sessionStorage.getItem("ayrus_auth_token");
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const changesState = ["POST", "PUT", "PATCH", "DELETE"].includes(method);

  if (changesState && path !== "/auth/login") {
    if (state.csrfToken) {
      headers.set("X-CSRF-Token", state.csrfToken);
    }
  }

  requestOptions.headers = headers;

  let response;

  try {
    response = await fetch(`${API_BASE}${path}`, requestOptions);
  } catch (_) {
    throw new Error(
      `Cannot reach the API. Make sure FastAPI is running at ${API_BASE}`
    );
  }

  const contentType = response.headers.get("content-type") || "";
  let data;

  if (contentType.includes("application/json")) {
    data = await response.json();
  } else {
    data = await response.text();
  }

  if (!response.ok) {
    if (response.status === 401 && state.authenticated && !path.startsWith("/auth/")) {
      showLogin("Your session has expired. Please sign in again.");
    }

    const detail =
      data && typeof data === "object"
        ? data.detail || data.message
        : data;

    throw new Error(
      typeof detail === "string"
        ? detail
        : `Request failed with HTTP ${response.status}`
    );
  }

  return data;
}

// ---------- API status ----------
function setConnection(connected) {
  $("connection-label").textContent = connected
    ? "API connected"
    : "API unavailable";

  const dot = document.querySelector(".status-dot");

  if (dot) {
    dot.style.background = connected ? "#69d6a0" : "#ff9090";
  }
}

async function checkApi() {
  try {
    await apiRequest("/health");
    setConnection(true);
    return true;
  } catch (_) {
    setConnection(false);
    return false;
  }
}

// ---------- Session management ----------
async function checkSession() {
  if (state.authCheckInProgress) return;

  state.authCheckInProgress = true;

  try {
    const apiAvailable = await checkApi();

    if (!apiAvailable) {
      showLogin("The API is unavailable. Start FastAPI, then try again.");
      return;
    }

    const session = await apiRequest("/auth/me");

    if (session && session.authenticated) {
      showDashboard(session.username, session.csrf_token);
      await Promise.all([loadMemories(), loadAgentPrompt()]);
    } else {
      showLogin();
    }
  } catch (error) {
    showLogin(error.message || "Unable to verify your session.");
  } finally {
    state.authCheckInProgress = false;
  }
}

async function login(event) {
  event.preventDefault();

  const button = $("login-button");
  const username = $("login-username").value.trim();
  const password = $("login-password").value;

  $("login-error").textContent = "";
  button.disabled = true;
  button.textContent = "Signing in…";

  try {
    const result = await apiRequest("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });

    $("login-password").value = "";

    if (result.token) {
      sessionStorage.setItem("ayrus_auth_token", result.token);
    }

    showDashboard(result.username || username, result.csrf_token);
    showToast("Signed in successfully.", "success");

    await Promise.all([loadMemories(), loadAgentPrompt()]);
  } catch (error) {
    $("login-error").textContent = error.message || "Sign-in failed.";
  } finally {
    button.disabled = false;
    button.textContent = "Sign in";
  }
}

async function logout() {
  const button = $("logout-button");
  button.disabled = true;

  try {
    await apiRequest("/auth/logout", { method: "POST" });

    sessionStorage.removeItem("ayrus_auth_token");
    state.memories = [];
    updateStats([]);
    $("memory-list").replaceChildren();

    showLogin();
    $("login-password").value = "";

    showToast("Signed out.", "success");
  } catch (error) {
    if (
      error.message.toLowerCase().includes("authentication required") ||
      error.message.includes("401")
    ) {
      showLogin("Your session has already expired. Please sign in again.");
    } else {
      showToast(`Could not sign out: ${error.message}`, "error");
    }
  } finally {
    button.disabled = false;
  }
}

// ---------- Voice capture ----------
function updateCharacterCount() {
  $("character-count").textContent =
    `${$("transcript").value.length} / 30000`;
}

function setRecordingUI(recording, message) {
  state.isRecording = recording;

  $("record-button").classList.toggle("recording", recording);
  $("record-button").setAttribute("aria-pressed", String(recording));
  $("record-button-label").textContent = recording
    ? "Stop recording"
    : "Start recording";
  $("record-status").textContent = message;
}

function startRecording() {
  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!SpeechRecognition) {
    showToast(
      "Speech recognition isn't supported in this browser. Try a recent version of Chrome or Edge.",
      "error"
    );
    return;
  }

  const recognition = new SpeechRecognition();

  recognition.lang = "en-IN";
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  state.recognition = recognition;
  state.finalTranscript = $("transcript").value.trim();

  recognition.onstart = () => {
    setRecordingUI(true, "Listening… speak naturally");
  };

  recognition.onresult = (event) => {
    let interimTranscript = "";

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const recognizedText = result[0].transcript;

      if (result.isFinal) {
        state.finalTranscript +=
          (state.finalTranscript ? " " : "") + recognizedText.trim();
      } else {
        interimTranscript += recognizedText;
      }
    }

    $("transcript").value = [
      state.finalTranscript,
      interimTranscript.trim(),
    ].filter(Boolean).join(" ");

    updateCharacterCount();
  };

  recognition.onerror = (event) => {
    const messages = {
      "not-allowed": "Microphone permission was denied. Allow microphone access in your browser.",
      "service-not-allowed": "The browser's speech recognition service is unavailable.",
      "no-speech": "No speech was detected. Try speaking closer to the microphone.",
      network: "Speech recognition encountered a network issue.",
      "audio-capture": "No microphone was detected.",
    };

    const message =
      messages[event.error] || `Speech recognition error: ${event.error}`;

    setRecordingUI(false, message);
    showToast(message, "error");
  };

  recognition.onend = () => {
    setRecordingUI(false, "Recording stopped. Review your transcript.");
    state.recognition = null;
  };

  try {
    recognition.start();
  } catch (error) {
    setRecordingUI(false, "Could not start recording.");
    showToast(error.message || "Unable to start speech recognition.", "error");
  }
}

function stopRecording() {
  if (state.recognition) {
    try {
      state.recognition.stop();
    } catch (_) {
      // Already stopped.
    }

    setRecordingUI(false, "Finishing transcript…");
  }
}

async function saveVoiceMemory() {
  const transcript = $("transcript").value.trim();

  if (!transcript) {
    showToast("Record or type a reflection before saving.", "error");
    return;
  }

  const button = $("save-voice-button");
  button.disabled = true;
  button.textContent = "Saving…";

  try {
    await apiRequest("/v1/memories/voice", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        transcript,
        sensitivity: $("voice-sensitivity").value,
      }),
    });

    $("transcript").value = "";
    state.finalTranscript = "";
    updateCharacterCount();

    showToast("Reflection saved successfully.", "success");
    await loadMemories();
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = "Save reflection";
  }
}

// ---------- Manual text memory ----------
function updateTextCharacterCount() {
  const field = $("text-reflection");

  $("text-character-count").textContent =
    `${field.value.length} / 10000`;
}

async function saveTextMemory() {
  const text = $("text-reflection").value.trim();

  if (!text) {
    showToast("Write a reflection before saving.", "error");
    return;
  }

  const button = $("save-text-button");
  button.disabled = true;
  button.textContent = "Saving…";

  try {
    await apiRequest("/v1/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        source_type: "text",
        sensitivity: $("text-sensitivity").value,
      }),
    });

    $("text-reflection").value = "";
    updateTextCharacterCount();

    showToast("Text memory saved successfully.", "success");
    await loadMemories();
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = "Save text memory";
  }
}

// ---------- Document upload ----------
async function uploadDocument(event) {
  event.preventDefault();

  const file = $("document-file").files[0];

  if (!file) {
    showToast("Choose a PDF or DOCX file first.", "error");
    return;
  }

  if (!/\.(pdf|docx)$/i.test(file.name)) {
    showToast("Only PDF and DOCX files are supported.", "error");
    return;
  }

  if (file.size > 10 * 1024 * 1024) {
    showToast("The file exceeds the 10 MB limit.", "error");
    return;
  }

  const button = $("upload-button");
  button.disabled = true;
  button.textContent = "Uploading…";

  try {
    const formData = new FormData();

    formData.append("file", file);
    formData.append("sensitivity", $("document-sensitivity").value);

    const result = await apiRequest("/v1/memories/documents", {
      method: "POST",
      body: formData,
    });

    const chunks = result.chunks_saved ?? "unknown";

    showToast(
      `Document saved successfully. Chunks created: ${chunks}.`,
      "success"
    );

    $("document-file").value = "";
    $("file-label").textContent = "Choose a PDF or DOCX file";

    await loadMemories();
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = "Upload document";
  }
}

// ---------- Memory library ----------
function normalizeMemories(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.memories)) return data.memories;
  if (data && Array.isArray(data.items)) return data.items;
  if (data && Array.isArray(data.records)) return data.records;

  return [];
}

function updateStats(memories) {
  const publicCount = memories.filter(
    (item) => item.sensitivity === "public"
  ).length;

  const privateCount = memories.filter(
    (item) => ["personal", "sensitive"].includes(item.sensitivity)
  ).length;

  $("memory-count").textContent = memories.length;
  $("public-count").textContent = publicCount;
  $("private-count").textContent = privateCount;
}

function formatDate(value) {
  if (!value) return "Date unavailable";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return "Date unavailable";

  return date.toLocaleString();
}

function getMemoryId(memory) {
  const candidate = memory.memory_id ?? memory.id ?? memory._id;

  if (candidate === undefined || candidate === null) return "";

  if (typeof candidate === "object" && candidate.$oid) {
    return String(candidate.$oid);
  }

  return String(candidate);
}

function createMemoryCard(memory) {
  const card = document.createElement("article");
  card.className = "memory-card";

  const top = document.createElement("div");
  top.className = "memory-card-top";

  const sensitivity = document.createElement("span");
  const level = ["public", "personal", "sensitive"].includes(memory.sensitivity)
    ? memory.sensitivity
    : "personal";

  sensitivity.className = `sensitivity ${level}`;
  sensitivity.textContent = level;

  const source = document.createElement("span");
  source.className = "source-tag";
  source.textContent = memory.source_type || "unknown source";

  top.append(sensitivity, source);
  card.append(top);

  const content = document.createElement("p");
  content.textContent = memory.text || "(No text available)";
  card.append(content);

  const meta = document.createElement("div");
  meta.className = "memory-meta";

  const documentDetails = memory.source_filename
    ? ` · ${memory.source_filename}`
    : "";

  const chunkDetails = Number.isInteger(memory.chunk_index)
    ? ` · Chunk ${memory.chunk_index + 1}`
    : "";

  meta.textContent =
    `${formatDate(memory.created_at)}${documentDetails}${chunkDetails}`;

  card.append(meta);

  const memoryId = getMemoryId(memory);

  if (memoryId) {
    const actions = document.createElement("div");
    actions.className = "memory-card-actions";

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "memory-delete-button";
    deleteButton.textContent = "Delete memory";
    deleteButton.setAttribute("aria-label", "Delete this memory");

    deleteButton.addEventListener("click", () => {
      deleteMemory(memoryId, deleteButton);
    });

    actions.append(deleteButton);
    card.append(actions);
  }

  return card;
}

// ---------- Delete memory ----------
async function deleteMemory(memoryId, button) {
  const memory = state.memories.find(
    (item) => getMemoryId(item) === memoryId
  );

  const preview = memory && memory.text
    ? memory.text.slice(0, 100)
    : "this memory";

  const suffix =
    memory && memory.text && memory.text.length > 100 ? "…" : "";

  const confirmed = window.confirm(
    `Delete this memory permanently?\n\n"${preview}${suffix}"`
  );

  if (!confirmed) return;

  button.disabled = true;
  button.textContent = "Deleting…";

  try {
    await apiRequest(
      `/v1/memories/${encodeURIComponent(memoryId)}`,
      { method: "DELETE" }
    );

    state.memories = state.memories.filter(
      (item) => getMemoryId(item) !== memoryId
    );

    updateStats(state.memories);
    renderMemories();

    showToast("Memory deleted successfully.", "success");
  } catch (error) {
    button.disabled = false;
    button.textContent = "Delete memory";

    showToast(`Could not delete memory: ${error.message}`, "error");
  }
}

// ---------- Render and filter memories ----------
function renderMemories() {
  const query = $("memory-search").value.trim().toLowerCase();
  const filter = $("memory-filter").value;

  const filtered = state.memories.filter((memory) => {
    const matchesText = String(memory.text || "")
      .toLowerCase()
      .includes(query);

    const matchesSensitivity =
      filter === "all" || memory.sensitivity === filter;

    return matchesText && matchesSensitivity;
  });

  const container = $("memory-list");
  container.replaceChildren();

  if (filtered.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";

    empty.textContent = state.memories.length
      ? "No memories match your filters."
      : "No memories were returned by the API.";

    container.append(empty);
    return;
  }

  filtered.forEach((memory) => {
    container.append(createMemoryCard(memory));
  });
}

async function loadMemories() {
  if (!state.authenticated) return;

  const container = $("memory-list");
  container.innerHTML = '<div class="empty-state">Loading memories…</div>';

  try {
    const data = await apiRequest("/v1/memories");

    state.memories = normalizeMemories(data);
    updateStats(state.memories);
    renderMemories();
  } catch (error) {
    container.replaceChildren();

    const message = document.createElement("div");
    message.className = "empty-state";
    message.textContent = `Could not load memories: ${error.message}`;

    container.append(message);

    if (state.authenticated) {
      showToast(error.message, "error");
    }
  }
}

// ---------- Agent System Prompt Management ----------
function updatePromptCharacterCount() {
  const textarea = $("agent-system-prompt");
  if (!textarea) return;
  const count = textarea.value.length;
  const counter = $("prompt-character-count");
  if (counter) {
    counter.textContent = `${count.toLocaleString()} characters`;
  }
}

async function loadAgentPrompt() {
  if (!state.authenticated) return;

  const textarea = $("agent-system-prompt");
  const badge = $("prompt-status-badge");
  const updatedInfo = $("prompt-updated-info");

  try {
    const data = await apiRequest("/v1/agent/prompt");
    if (textarea) {
      textarea.value = data.prompt || "";
      updatePromptCharacterCount();
    }

    if (badge) {
      if (data.is_default) {
        badge.textContent = "Default Prompt";
        badge.className = "pill pill-default";
      } else {
        badge.textContent = "Custom Prompt Active";
        badge.className = "pill pill-custom";
      }
    }

    if (updatedInfo) {
      if (data.is_default) {
        updatedInfo.textContent = "Using built-in system prompt.";
      } else if (data.updated_at) {
        const d = new Date(data.updated_at);
        updatedInfo.textContent = `Last saved: ${d.toLocaleDateString()} ${d.toLocaleTimeString()}`;
      } else {
        updatedInfo.textContent = "Custom prompt active.";
      }
    }
  } catch (error) {
    if (badge) {
      badge.textContent = "Error loading";
    }
    if (state.authenticated) {
      showToast(`Could not load prompt: ${error.message}`, "error");
    }
  }
}

async function saveAgentPrompt() {
  if (!state.authenticated) return;

  const textarea = $("agent-system-prompt");
  const saveBtn = $("save-prompt-button");
  const prompt = textarea.value.trim();

  if (!prompt) {
    showToast("Prompt cannot be empty.", "error");
    return;
  }

  saveBtn.disabled = true;
  saveBtn.textContent = "Saving…";

  try {
    await apiRequest("/v1/agent/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });

    showToast("Ayrus prompt saved and active!", "success");
    await loadAgentPrompt();
  } catch (error) {
    showToast(`Failed to save prompt: ${error.message}`, "error");
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = "Save prompt";
  }
}

async function resetAgentPrompt() {
  if (!state.authenticated) return;

  const confirmed = window.confirm("Reset Ayrus prompt back to default built-in instructions?");
  if (!confirmed) return;

  const resetBtn = $("reset-prompt-button");
  resetBtn.disabled = true;
  resetBtn.textContent = "Resetting…";

  try {
    await apiRequest("/v1/agent/prompt/reset", {
      method: "POST",
    });

    showToast("Prompt reset to default.", "success");
    await loadAgentPrompt();
  } catch (error) {
    showToast(`Failed to reset prompt: ${error.message}`, "error");
  } finally {
    resetBtn.disabled = false;
    resetBtn.textContent = "Reset to default";
  }
}

// ---------- Event listeners ----------
$("login-form").addEventListener("submit", login);
$("logout-button").addEventListener("click", logout);

$("record-button").addEventListener("click", () => {
  if (state.isRecording) {
    stopRecording();
  } else {
    startRecording();
  }
});

$("transcript").addEventListener("input", updateCharacterCount);
$("save-voice-button").addEventListener("click", saveVoiceMemory);

$("text-reflection").addEventListener("input", updateTextCharacterCount);
$("save-text-button").addEventListener("click", saveTextMemory);

$("document-form").addEventListener("submit", uploadDocument);

$("document-file").addEventListener("change", () => {
  const file = $("document-file").files[0];

  $("file-label").textContent = file
    ? file.name
    : "Choose a PDF or DOCX file";
});

$("memory-search").addEventListener("input", renderMemories);
$("memory-filter").addEventListener("change", renderMemories);

$("agent-system-prompt").addEventListener("input", updatePromptCharacterCount);
$("save-prompt-button").addEventListener("click", saveAgentPrompt);
$("reset-prompt-button").addEventListener("click", resetAgentPrompt);

$("refresh-button").addEventListener("click", async () => {
  const connected = await checkApi();

  if (connected && state.authenticated) {
    await Promise.all([loadMemories(), loadAgentPrompt()]);
  }
});

$("memory-refresh-button").addEventListener("click", loadMemories);

window.addEventListener("beforeunload", () => {
  if (state.recognition) {
    try {
      state.recognition.abort();
    } catch (_) {
      // Already stopped.
    }
  }
});

// ---------- Initialization ----------
updateCharacterCount();
updateTextCharacterCount();
showLogin();
checkSession();
