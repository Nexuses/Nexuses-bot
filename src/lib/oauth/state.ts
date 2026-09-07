import { jwtVerify, SignJWT } from "jose";

export type OauthState = {
  userId: string;
  projectId: string;
  provider: string;
  /** Exact redirect_uri used in the authorize request (must match token exchange). */
  redirectUri: string;
};

function getSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is not set");
  return new TextEncoder().encode(secret);
}

export async function signOauthState(state: OauthState) {
  return new SignJWT({
    typ: "oauth",
    userId: state.userId,
    projectId: state.projectId,
    provider: state.provider,
    redirectUri: state.redirectUri,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(getSecret());
}

export async function verifyOauthState(token: string): Promise<OauthState | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret());
    if (
      payload.typ !== "oauth" ||
      typeof payload.userId !== "string" ||
      typeof payload.projectId !== "string" ||
      typeof payload.provider !== "string" ||
      typeof payload.redirectUri !== "string"
    ) {
      return null;
    }
    return {
      userId: payload.userId,
      projectId: payload.projectId,
      provider: payload.provider,
      redirectUri: payload.redirectUri,
    };
  } catch {
    return null;
  }
}
