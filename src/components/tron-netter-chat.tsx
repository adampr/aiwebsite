"use client";

import { useState, useRef, useEffect, useCallback } from "react";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

const STORAGE_KEY = "tron-netter-chat-state";

function generateSessionId() {
  return `tron_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function loadPersistedState(): {
  isOpen: boolean;
  messages: ChatMessage[];
  sessionId: string;
  hasUnread: boolean;
} {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        isOpen: !!parsed.isOpen,
        messages: Array.isArray(parsed.messages) ? parsed.messages : [],
        sessionId:
          typeof parsed.sessionId === "string" && parsed.sessionId
            ? parsed.sessionId
            : generateSessionId(),
        hasUnread: !!parsed.hasUnread,
      };
    }
  } catch {
    /* ignore corrupt storage */
  }
  return { isOpen: false, messages: [], sessionId: generateSessionId(), hasUnread: false };
}

export function TronNetterChat() {
  const [hydrated, setHydrated] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [sessionId, setSessionId] = useState(generateSessionId);
  const [hasUnread, setHasUnread] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const isOpenRef = useRef(isOpen);

  useEffect(() => {
    isOpenRef.current = isOpen;
  }, [isOpen]);

  useEffect(() => {
    const saved = loadPersistedState();
    setIsOpen(saved.isOpen);
    setMessages(saved.messages);
    setSessionId(saved.sessionId);
    setHasUnread(saved.hasUnread);
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      sessionStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ isOpen, messages, sessionId, hasUnread })
      );
    } catch {
      /* storage full or unavailable */
    }
  }, [hydrated, isOpen, messages, sessionId, hasUnread]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (isOpen) {
      inputRef.current?.focus();
    }
  }, [isOpen]);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || isLoading) return;

    const userMsg: ChatMessage = { role: "user", content: text };
    const updatedMessages = [...messages, userMsg];
    setMessages(updatedMessages);
    setInput("");
    setIsLoading(true);

    try {
      const res = await fetch("/api/tron-netter/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: updatedMessages, sessionId }),
      });
      if (!res.ok) throw new Error("Chat request failed");
      const data = await res.json();
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: data.answer },
      ]);
      if (!isOpenRef.current) setHasUnread(true);
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: "Sorry, I encountered an error. Please try again.",
        },
      ]);
      if (!isOpenRef.current) setHasUnread(true);
    } finally {
      setIsLoading(false);
    }
  }, [input, isLoading, messages, sessionId]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <>
      {/* Floating bubble */}
      <button
        onClick={() => {
          setIsOpen((o) => {
            if (!o) setHasUnread(false);
            return !o;
          });
        }}
        className="fixed bottom-6 right-6 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-[var(--xl-primary)] text-white shadow-lg transition-transform hover:scale-105 hover:bg-[var(--xl-primary-light)] focus:outline-none focus:ring-2 focus:ring-[var(--xl-primary)] focus:ring-offset-2"
        aria-label={isOpen ? "Minimize Tron Netter chat" : "Open Tron Netter chat"}
      >
        {isOpen ? (
          <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
        )}
        {hasUnread && !isOpen && (
          <span className="absolute -right-0.5 -top-0.5 h-3 w-3 rounded-full bg-[var(--xl-cta)] ring-2 ring-white dark:ring-neutral-950" />
        )}
      </button>

      {/* Chat panel */}
      {hydrated && isOpen && (
        <div className="fixed bottom-24 right-6 z-50 flex h-[28rem] w-[22rem] flex-col overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-2xl dark:border-neutral-700 dark:bg-neutral-900 sm:w-96">
          {/* Header */}
          <div className="flex items-center gap-3 border-b border-neutral-200 bg-[var(--xl-primary)] px-4 py-3 dark:border-neutral-700">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-white/20 text-sm font-bold text-white">
              T
            </div>
            <div className="flex-1">
              <p className="text-sm font-semibold text-white">Tron Netter</p>
              <p className="text-xs text-white/70">XL.net AI Assistant</p>
            </div>
            <button
              onClick={() => setIsOpen(false)}
              className="flex h-7 w-7 items-center justify-center rounded-md text-white/70 transition-colors hover:bg-white/20 hover:text-white"
              aria-label="Minimize chat"
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2.5}>
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-4">
            {messages.length === 0 && (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
                <p className="text-sm font-medium text-neutral-600 dark:text-neutral-400">
                  Hi! I&apos;m Tron Netter.
                </p>
                <p className="text-xs text-neutral-500 dark:text-neutral-400">
                  Ask me about XL.net&apos;s AI capabilities, services, or how we leverage AI for managed IT.
                </p>
              </div>
            )}
            {messages.map((msg, i) => (
              <div
                key={i}
                className={`mb-3 flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[80%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${
                    msg.role === "user"
                      ? "bg-[var(--xl-primary)] text-white"
                      : "bg-neutral-100 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100"
                  }`}
                >
                  {msg.content}
                </div>
              </div>
            ))}
            {isLoading && (
              <div className="mb-3 flex justify-start">
                <div className="rounded-lg bg-neutral-100 px-3 py-2 dark:bg-neutral-800">
                  <div className="flex gap-1">
                    <span className="h-2 w-2 animate-bounce rounded-full bg-neutral-400 [animation-delay:-0.3s]" />
                    <span className="h-2 w-2 animate-bounce rounded-full bg-neutral-400 [animation-delay:-0.15s]" />
                    <span className="h-2 w-2 animate-bounce rounded-full bg-neutral-400" />
                  </div>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div className="border-t border-neutral-200 p-3 dark:border-neutral-700">
            <div className="flex items-end gap-2">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask Tron Netter..."
                rows={1}
                className="flex-1 resize-none rounded-lg border border-neutral-300 bg-transparent px-3 py-2 text-sm outline-none placeholder:text-neutral-400 focus:border-[var(--xl-primary)] dark:border-neutral-600 dark:placeholder:text-neutral-500 dark:focus:border-[#7b7bff]"
                disabled={isLoading}
              />
              <button
                onClick={sendMessage}
                disabled={!input.trim() || isLoading}
                className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--xl-primary)] text-white transition-colors hover:bg-[var(--xl-primary-light)] disabled:opacity-50"
                aria-label="Send message"
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path d="m22 2-7 20-4-9-9-4zM22 2 11 13" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
