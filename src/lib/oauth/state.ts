import { jwtVerify, SignJWT } from "jose";

export type OauthState = {
  userId: string;
  projectId: string;
  provider: string;
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
      typeof payload.provider !== "string"
    ) {
      return null;
    }
    return {
      userId: payload.userId,
      projectId: payload.projectId,
      provider: payload.provider,
    };
  } catch {
    return null;
  }
}
