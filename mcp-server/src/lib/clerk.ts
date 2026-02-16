import { createClerkClient } from "@clerk/backend";

const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY;

function getClerkClient() {
  if (!CLERK_SECRET_KEY) {
    throw new Error(
      "CLERK_SECRET_KEY is required for agent registration. " +
        "Set it in your mcp-server/.env file.",
    );
  }
  return createClerkClient({ secretKey: CLERK_SECRET_KEY });
}

/**
 * Find an existing Clerk user by email, or create a new one.
 * Returns the Clerk user ID (e.g. "user_2abc...").
 *
 * If the email already exists in Clerk (e.g. user signed up via web UI),
 * we return the existing user's ID so the Convex record stays unified.
 */
export async function findOrCreateClerkUser(
  name: string,
  email: string,
  githubUsername?: string,
): Promise<{ clerkId: string; isExisting: boolean }> {
  const clerk = getClerkClient();

  // Check if user already exists by email
  const existingUsers = await clerk.users.getUserList({
    emailAddress: [email],
  });

  if (existingUsers.data.length > 0) {
    return { clerkId: existingUsers.data[0].id, isExisting: true };
  }

  // Parse name into first/last
  const nameParts = name.trim().split(/\s+/);
  const firstName = nameParts[0] || name;
  const lastName = nameParts.length > 1 ? nameParts.slice(1).join(" ") : undefined;

  // Create new Clerk user (passwordless — they can set a password later via web UI)
  const newUser = await clerk.users.createUser({
    emailAddress: [email],
    firstName,
    lastName,
    username: githubUsername,
    skipPasswordRequirement: true,
  });

  return { clerkId: newUser.id, isExisting: false };
}
