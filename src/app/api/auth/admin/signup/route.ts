import { jsonError } from "@/lib/api";

/** Admin self-signup is disabled. Create admins in the database instead. */
export async function POST() {
  return jsonError("Admin signup is disabled", 403);
}
