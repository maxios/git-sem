/**
 * Format versions of derived records. Bumping one makes git-sem ignore
 * records of the older format and recompute them.
 *
 *   entities/v2  merges record only their own changes (#2); events carry
 *                export status (#3); Tier 1 links need enough tokens (#4)
 *   entities/v3  wrapped signatures are extracted (#12); same-name moves
 *                link (#11)
 */
export const ENTITIES_VERSION = "entities/v3";
export const CHANGES_VERSION = "changes/v1";
export const FILE_VERSION = "file/v1";
