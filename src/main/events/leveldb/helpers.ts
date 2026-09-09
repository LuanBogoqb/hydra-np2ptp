import { db } from "@main/level";
import { isValidSublevelName } from "./write-policy";

// Re-exported so the IPC handlers keep importing the write policy through
// this choke point.
export {
  assertWritable,
  isValidSublevelName,
  WRITER_POLICY,
  GAME_RECORD_FIELDS,
} from "./write-policy";

const sublevelCache = new Map<
  string,
  ReturnType<typeof db.sublevel<string, unknown>>
>();

/**
 * Gets a sublevel by name, creating it if it doesn't exist.
 * All sublevels use "json" encoding by default.
 * The name is validated for every op (read and write) so path-ish names
 * never reach a sublevel handle.
 * @param sublevelName - The name of the sublevel to get or create
 * @returns The sublevel instance
 */
export const getSublevelByName = (
  sublevelName: string
): ReturnType<typeof db.sublevel<string, unknown>> => {
  if (!isValidSublevelName(sublevelName)) {
    throw new Error(
      `Leveldb sublevel rejected: ${JSON.stringify(
        sublevelName
      )} is not a valid sublevel name`
    );
  }

  if (sublevelCache.has(sublevelName)) {
    return sublevelCache.get(sublevelName)!;
  }

  // All sublevels use "json" encoding - this cannot be changed per sublevel
  const sublevel = db.sublevel<string, unknown>(sublevelName, {
    valueEncoding: "json",
  });
  sublevelCache.set(sublevelName, sublevel);
  return sublevel;
};
