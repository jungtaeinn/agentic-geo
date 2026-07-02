import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { geoCitationContentRagManifest } from "./manifest";
import { geoCitationRagIndex } from "./rag-index";
import type { GeoCitationRagDocument, SupportedGeoCitationSurface } from "../types";

export interface StoredGeoCitationRagDocument extends GeoCitationRagDocument {
  managed: boolean;
  path: string;
  size: number;
  updatedAt?: string;
}

export interface StoredGeoCitationRagProfile {
  profile: string;
  mandatoryDocuments: StoredGeoCitationRagDocument[];
  surfaceDocuments: Record<SupportedGeoCitationSurface, StoredGeoCitationRagDocument[]>;
  updatedAt?: string;
}

const ragDirectory = resolveDefaultRagDirectory();

export async function readGeoCitationRagProfile(directory = ragDirectory): Promise<StoredGeoCitationRagProfile> {
  const mandatoryDocuments = await Promise.all(
    Object.values(geoCitationContentRagManifest.mandatory).map((name) =>
      readManagedDocument(directory, join("mandatory", name))
    )
  );
  const redditDocuments = await Promise.all(
    Object.values(geoCitationContentRagManifest.surfaces.reddit).map((name) =>
      readManagedDocument(directory, join("../surfaces/reddit/rag", name), "reddit")
    )
  );
  const updatedAt = [...mandatoryDocuments, ...redditDocuments]
    .map((document) => document.updatedAt)
    .filter((value): value is string => typeof value === "string")
    .sort()
    .at(-1);

  return {
    profile: geoCitationContentRagManifest.profile,
    mandatoryDocuments,
    surfaceDocuments: {
      reddit: redditDocuments
    },
    updatedAt
  };
}

async function readManagedDocument(
  directory: string,
  relativePath: string,
  surface?: SupportedGeoCitationSurface
): Promise<StoredGeoCitationRagDocument> {
  const name = relativePath.split(/[\\/]/).at(-1) ?? relativePath;
  const path = join(directory, relativePath);
  const content = await readTextFile(path, "");
  const metadata = await fileMetadata(path, content);
  const indexEntry = geoCitationRagIndex.find((entry) => entry.document === name);

  return {
    name,
    version: indexEntry?.version ?? "v1",
    sourceRole: indexEntry?.sourceRole ?? "mandatory-policy",
    surface,
    mandatory: indexEntry?.mandatory ?? !surface,
    content,
    managed: true,
    path: relativePath,
    ...metadata
  };
}

async function readTextFile(path: string, fallback: string): Promise<string> {
  return readFile(path, "utf8").catch(() => fallback);
}

async function fileMetadata(path: string, content: string): Promise<Pick<StoredGeoCitationRagDocument, "size" | "updatedAt">> {
  const fileStat = await stat(path).catch(() => undefined);

  return {
    size: Buffer.byteLength(content),
    updatedAt: fileStat?.mtime.toISOString()
  };
}

function resolveDefaultRagDirectory(): string {
  const currentDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    currentDirectory,
    resolve(process.cwd(), "packages/geo-citation-content-agent/src/rag"),
    resolve(process.cwd(), "../../packages/geo-citation-content-agent/src/rag"),
    resolve(process.cwd(), "src/rag")
  ];

  return candidates.find((candidate) => existsSync(join(candidate, "manifest.ts"))) ?? currentDirectory;
}
