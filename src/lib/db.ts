import mongoose from "mongoose";

// Register every schema when connecting. Next.js production chunks can load
// Project (or other models) without User, and .populate("members") then throws
// MissingSchemaError: Schema hasn't been registered for model "User".
import "@/models/User";
import "@/models/Project";
import "@/models/Integration";
import "@/models/Chat";
import "@/models/Message";
import "@/models/Automation";
import "@/models/HtmlShare";

const MONGODB_URI = process.env.MONGODB_URI;

const globalForMongoose = globalThis as unknown as {
  mongooseCache?: {
    conn: typeof mongoose | null;
    promise: Promise<typeof mongoose> | null;
  };
};

const cache = globalForMongoose.mongooseCache ?? {
  conn: null,
  promise: null,
};

if (!globalForMongoose.mongooseCache) {
  globalForMongoose.mongooseCache = cache;
}

export async function dbConnect() {
  if (!MONGODB_URI) {
    throw new Error("MONGODB_URI is not set");
  }

  if (cache.conn) {
    return cache.conn;
  }

  if (!cache.promise) {
    cache.promise = mongoose.connect(MONGODB_URI, { dbName: "nexuses-bot" });
  }

  cache.conn = await cache.promise;
  return cache.conn;
}
