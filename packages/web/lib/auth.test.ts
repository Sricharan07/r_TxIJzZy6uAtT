import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
  const cookieValues = new Map<string, string>();
  return {
    cookieValues,
    cookieSet: vi.fn((name: string, value: string, options?: { maxAge?: number }) => {
      if (options?.maxAge === 0 || value === "") cookieValues.delete(name);
      else cookieValues.set(name, value);
    }),
    store: {
      createSession: vi.fn(),
      getSessionUserId: vi.fn(),
      getUser: vi.fn(),
      getOrCreateDevUser: vi.fn(),
      deleteSession: vi.fn(),
    },
  };
});

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = state.cookieValues.get(name);
      return value === undefined ? undefined : { name, value };
    },
    set: state.cookieSet,
  }),
}));

vi.mock("@kiln/shared/store", () => ({
  getStore: () => state.store,
}));

import { clearCurrentSession, createUserSession, currentUserId } from "./auth";

function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

describe("web auth sessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    state.cookieValues.clear();
    state.store.getOrCreateDevUser.mockResolvedValue({
      id: "dev-user",
      login: "dev",
      avatarUrl: "",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("creates an opaque browser cookie and stores only the token hash", async () => {
    await createUserSession("user-1");

    expect(state.store.createSession).toHaveBeenCalledTimes(1);
    const [tokenHash, userId, expiresAt] = state.store.createSession.mock.calls[0]!;
    expect(tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(userId).toBe("user-1");
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());

    const token = state.cookieValues.get("id");
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(tokenHash).toBe(hash(token!));
    expect(state.cookieSet).toHaveBeenCalledWith(
      "id",
      token,
      expect.objectContaining({ httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 30 }),
    );
  });

  it("resolves the current user through the server-side session store", async () => {
    state.cookieValues.set("id", "session-token");
    state.store.getSessionUserId.mockResolvedValue("user-1");
    state.store.getUser.mockResolvedValue({
      id: "user-1",
      login: "octo",
      avatarUrl: "",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    await expect(currentUserId()).resolves.toBe("user-1");
    expect(state.store.getSessionUserId).toHaveBeenCalledWith(hash("session-token"));
    expect(state.store.getUser).toHaveBeenCalledWith("user-1");
    expect(state.store.getOrCreateDevUser).not.toHaveBeenCalled();
  });

  it("deletes the persisted session when clearing the browser cookie", async () => {
    state.cookieValues.set("id", "session-token");

    await clearCurrentSession();

    expect(state.store.deleteSession).toHaveBeenCalledWith(hash("session-token"));
    expect(state.cookieValues.has("id")).toBe(false);
    expect(state.cookieSet).toHaveBeenCalledWith(
      "id",
      "",
      expect.objectContaining({ maxAge: 0, httpOnly: true, path: "/" }),
    );
  });

  it("does not seed a dev user when authentication is required", async () => {
    vi.stubEnv("KILN_REQUIRE_AUTH", "1");

    await expect(currentUserId()).resolves.toBeNull();
    expect(state.store.getOrCreateDevUser).not.toHaveBeenCalled();
  });
});
