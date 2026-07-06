import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import {
  defaultPdpGeoGeneratorRagProfile,
  type PdpGeoGeneratorRagDocument,
  type PdpGeoGeneratorRagProfile
} from "./default-profile";
import { pdpGeoGeneratorRagManifest } from "./manifest";

export interface StoredPdpGeoGeneratorRagDocument extends PdpGeoGeneratorRagDocument {
  managed: boolean;
  path: string;
  size: number;
  updatedAt?: string;
}

export interface StoredPdpGeoGeneratorRagProfile extends Omit<PdpGeoGeneratorRagProfile, "documents"> {
  documents: StoredPdpGeoGeneratorRagDocument[];
  updatedAt?: string;
}

const ragDirectory = resolveDefaultRagDirectory();
const brandDirectoryName = "brands";
const customDirectoryName = "custom";
const allowedRagFileExtensions = new Set([".md", ".txt", ".json", ".csv"]);

/** Reads the package-managed prompt and RAG files used by the PDP GEO generator agent. */
export async function readPdpGeoGeneratorRagProfile(directory = ragDirectory): Promise<StoredPdpGeoGeneratorRagProfile> {
  const analysisPrompt = await readTextFile(
    join(directory, pdpGeoGeneratorRagManifest.analysisPrompt),
    defaultPdpGeoGeneratorRagProfile.analysisPrompt
  );
  const documents = [
    ...await Promise.all(defaultPdpGeoGeneratorRagProfile.documents.map((document) => readManagedDocument(directory, document))),
    ...await readBrandDocuments(directory),
    ...await readCustomDocuments(directory)
  ];
  const updatedAt = documents
    .map((document) => document.updatedAt)
    .filter((value): value is string => typeof value === "string")
    .sort()
    .at(-1);

  return {
    profile: pdpGeoGeneratorRagManifest.profile,
    analysisPrompt,
    documents,
    updatedAt
  };
}

/** Writes prompt and RAG file changes back into the package RAG directory. */
export async function writePdpGeoGeneratorRagProfile(
  profile: Pick<PdpGeoGeneratorRagProfile, "analysisPrompt"> & {
    documents?: Array<Pick<PdpGeoGeneratorRagDocument, "name" | "content"> & Partial<Pick<PdpGeoGeneratorRagDocument, "version">>>;
  },
  directory = ragDirectory
): Promise<StoredPdpGeoGeneratorRagProfile> {
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, pdpGeoGeneratorRagManifest.analysisPrompt),
    ensureTrailingNewline(profile.analysisPrompt || defaultPdpGeoGeneratorRagProfile.analysisPrompt),
    "utf8"
  );

  const incomingDocuments = new Map((profile.documents ?? []).map((document) => [document.name, document]));

  for (const defaultDocument of defaultPdpGeoGeneratorRagProfile.documents) {
    const document = incomingDocuments.get(defaultDocument.name) ?? defaultDocument;
    await writeManagedRagFile(directory, defaultDocument.name, document.content);
  }

  await writeBrandDocuments(directory, (profile.documents ?? []).filter((document) => isBrandDocumentName(document.name)));
  await writeCustomDocuments(directory, (profile.documents ?? []).filter((document) => !isManagedDocumentName(document.name) && !isBrandDocumentName(document.name)));

  return readPdpGeoGeneratorRagProfile(directory);
}

/** Restores package RAG files to the agent defaults and clears custom attachments. */
export async function resetPdpGeoGeneratorRagProfile(directory = ragDirectory): Promise<StoredPdpGeoGeneratorRagProfile> {
  await clearCustomDocuments(directory);
  return writePdpGeoGeneratorRagProfile(defaultPdpGeoGeneratorRagProfile, directory);
}

async function readManagedDocument(directory: string, document: PdpGeoGeneratorRagDocument): Promise<StoredPdpGeoGeneratorRagDocument> {
  const path = join(directory, document.name);
  const content = await readTextFile(path, document.content);
  const metadata = await fileMetadata(path, content);

  return {
    ...document,
    content,
    managed: true,
    path: document.name,
    ...metadata
  };
}

async function readBrandDocuments(directory: string): Promise<StoredPdpGeoGeneratorRagDocument[]> {
  const brandDirectory = join(directory, brandDirectoryName);
  const paths = await readRagFilePaths(brandDirectory);
  const documents = await Promise.all(
    paths.map(async (path): Promise<StoredPdpGeoGeneratorRagDocument> => {
      const relativePath = toRagRelativePath(join(brandDirectoryName, relative(brandDirectory, path)));
      const content = await readTextFile(path, "");
      const metadata = await fileMetadata(path, content);

      return {
        name: relativePath,
        version: extractVersion(relativePath),
        content,
        managed: true,
        path: relativePath,
        ...metadata
      };
    })
  );

  return documents.sort((a, b) => a.name.localeCompare(b.name));
}

async function readCustomDocuments(directory: string): Promise<StoredPdpGeoGeneratorRagDocument[]> {
  const customDirectory = join(directory, customDirectoryName);
  const names = await readdir(customDirectory).catch(() => []);
  const documents = await Promise.all(
    names
      .filter((name) => allowedRagFileExtensions.has(extname(name).toLowerCase()))
      .map(async (name): Promise<StoredPdpGeoGeneratorRagDocument> => {
        const path = join(customDirectory, name);
        const content = await readTextFile(path, "");
        const metadata = await fileMetadata(path, content);

        return {
          name,
          version: extractVersion(name),
          content,
          managed: false,
          path: `${customDirectoryName}/${name}`,
          ...metadata
        };
      })
  );

  return documents.sort((a, b) => a.name.localeCompare(b.name));
}

async function writeBrandDocuments(
  directory: string,
  documents: Array<Pick<PdpGeoGeneratorRagDocument, "name" | "content"> & Partial<Pick<PdpGeoGeneratorRagDocument, "version">>>
) {
  for (const document of documents) {
    const name = safeBrandDocumentName(document.name, document.version);
    if (name) {
      await writeManagedRagFile(directory, name, document.content);
    }
  }
}

async function writeCustomDocuments(
  directory: string,
  documents: Array<Pick<PdpGeoGeneratorRagDocument, "name" | "content"> & Partial<Pick<PdpGeoGeneratorRagDocument, "version">>>
) {
  const customDirectory = join(directory, customDirectoryName);
  await mkdir(customDirectory, { recursive: true });
  const nextNames = new Set<string>();

  for (const document of documents) {
    const name = safeRagFileName(document.name, document.version);
    nextNames.add(name);
    await writeFile(join(customDirectory, name), ensureTrailingNewline(document.content), "utf8");
  }

  const existingNames = await readdir(customDirectory).catch(() => []);
  await Promise.all(
    existingNames
      .filter((name) => allowedRagFileExtensions.has(extname(name).toLowerCase()) && !nextNames.has(name))
      .map((name) => unlink(join(customDirectory, name)).catch(() => undefined))
  );
}

async function writeManagedRagFile(directory: string, name: string, content: string) {
  const path = join(directory, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, ensureTrailingNewline(content), "utf8");
}

async function clearCustomDocuments(directory: string) {
  const customDirectory = join(directory, customDirectoryName);
  const existingNames = await readdir(customDirectory).catch(() => []);
  await Promise.all(
    existingNames
      .filter((name) => allowedRagFileExtensions.has(extname(name).toLowerCase()))
      .map((name) => unlink(join(customDirectory, name)).catch(() => undefined))
  );
}

async function readRagFilePaths(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const paths = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return readRagFilePaths(path);
    }
    return allowedRagFileExtensions.has(extname(entry.name).toLowerCase()) ? [path] : [];
  }));

  return paths.flat().sort((a, b) => a.localeCompare(b));
}

async function readTextFile(path: string, fallback: string): Promise<string> {
  return readFile(path, "utf8").catch(() => fallback);
}

async function fileMetadata(path: string, content: string): Promise<Pick<StoredPdpGeoGeneratorRagDocument, "size" | "updatedAt">> {
  const fileStat = await stat(path).catch(() => undefined);

  return {
    size: Buffer.byteLength(content),
    updatedAt: fileStat?.mtime.toISOString()
  };
}

function safeBrandDocumentName(name: string, version = "v1"): string | undefined {
  const normalized = toRagRelativePath(name).replace(/^\/+/, "");
  if (!normalized.startsWith(`${brandDirectoryName}/`)) {
    return undefined;
  }

  const parts = normalized.split("/").filter(Boolean);
  if (parts.length < 3 || parts.some((part) => part === "." || part === "..")) {
    return undefined;
  }

  const folders = parts.slice(0, -1).map(safeRagPathSegment).filter(Boolean);
  const fileName = safeRagFileName(parts.at(-1) ?? "brand-identity.md", version);

  return join(...folders, fileName);
}

function safeRagPathSegment(name: string): string {
  return name
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function safeRagFileName(name: string, version = "v1"): string {
  const extension = allowedRagFileExtensions.has(extname(name).toLowerCase()) ? extname(name).toLowerCase() : ".md";
  const baseName = name
    .replace(/\.[^.]+$/, "")
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "rag-document";
  const versionedBaseName = /_v\d+$/i.test(baseName) ? baseName : `${baseName}_${version}`;

  return `${versionedBaseName}${extension}`;
}

function isManagedDocumentName(name: string): boolean {
  return defaultPdpGeoGeneratorRagProfile.documents.some((document) => document.name === name);
}

function isBrandDocumentName(name: string): boolean {
  return toRagRelativePath(name).startsWith(`${brandDirectoryName}/`);
}

function toRagRelativePath(name: string): string {
  return name.replace(/\\/g, "/");
}

function extractVersion(name: string): string {
  return name.match(/_v(\d+)\.[^.]+$/i)?.[1] ? `v${name.match(/_v(\d+)\.[^.]+$/i)?.[1]}` : "v1";
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function resolveDefaultRagDirectory(): string {
  const candidates = [
    resolve(process.cwd(), "packages/pdp-geo-generator-agent/src/rag"),
    resolve(process.cwd(), "../../packages/pdp-geo-generator-agent/src/rag"),
    resolve(process.cwd(), "src/rag")
  ];

  return candidates.find((candidate) => existsSync(join(candidate, "manifest.ts"))) ?? candidates[0] ?? process.cwd();
}
