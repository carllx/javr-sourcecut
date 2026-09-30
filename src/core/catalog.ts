import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

export interface PerformerRecord {
  id: string;
  name: string;
  aliases?: string[];
  dateOfBirth?: string;
  region?: "asian" | "western" | "unclassified";
}

export interface WorkIdentifier {
  scheme: string;
  value: string;
}

export interface IdentificationEvidence {
  source: string;
  evidenceKey?: string;
  evidenceValue: string;
  recordedAt: string;
}

export interface SourceReference {
  id?: string;
  provider: string;
  sourceUrl: string;
  providerAssetId?: string;
  rawTitle?: string;
}

export interface LocalFileRecord {
  id: string;
  workId: string;
  path: string;
  sizeBytes?: number;
  format?: string;
  codec?: string;
  resolution?: string;
}

export interface WorkRecord {
  id: string;
  title: string;
  identifiers: WorkIdentifier[];
  performers: PerformerRecord[];
  sourceReferences: SourceReference[];
  evidences: IdentificationEvidence[];
  localFiles: LocalFileRecord[];
  isLibraryReady: boolean;
  director?: string;
  releaseDate?: string;
  shootDate?: string;
}

export interface ConfirmedMediaInput {
  work: {
    title: string;
    identifiers: WorkIdentifier[];
    director?: string;
    releaseDate?: string;
    shootDate?: string;
  };
  performers: {
    name: string;
    aliases?: string[];
    dateOfBirth?: string;
    region?: "asian" | "western" | "unclassified";
  }[];
  localFile: {
    path: string;
    sizeBytes?: number;
    format?: string;
    codec?: string;
    resolution?: string;
  };
  sourceReferences?: {
    provider: string;
    sourceUrl: string;
    providerAssetId?: string;
    rawTitle?: string;
  }[];
  evidences?: {
    source: string;
    evidenceKey?: string;
    evidenceValue: string;
    recordedAt?: string;
  }[];
}

interface RawLocalFileRow {
  id: string;
  work_id: string;
  path: string;
  size_bytes: number | null;
  format: string | null;
  codec: string | null;
  resolution: string | null;
}

interface RawPerformerRow {
  id: string;
  name: string;
  aliases_json: string | null;
  date_of_birth: string | null;
  region: "asian" | "western" | "unclassified" | null;
}

export class MediaCatalog {
  private db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.db = db;
    this.initSchema();
  }

  public static open(dbPath: string): MediaCatalog {
    const db = new DatabaseSync(dbPath);
    return new MediaCatalog(db);
  }

  public close(): void {
    this.db.close();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS performers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        aliases_json TEXT,
        date_of_birth TEXT,
        region TEXT
      );

      CREATE TABLE IF NOT EXISTS works (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        director TEXT,
        release_date TEXT,
        shoot_date TEXT,
        is_library_ready INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS work_identifiers (
        work_id TEXT NOT NULL,
        scheme TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (work_id, scheme, value)
      );
      CREATE INDEX IF NOT EXISTS idx_work_identifiers_val ON work_identifiers(value);
      CREATE INDEX IF NOT EXISTS idx_work_identifiers_scheme_val ON work_identifiers(scheme, value);

      CREATE TABLE IF NOT EXISTS work_performers (
        work_id TEXT NOT NULL,
        performer_id TEXT NOT NULL,
        PRIMARY KEY (work_id, performer_id)
      );

      CREATE TABLE IF NOT EXISTS local_files (
        id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL,
        path TEXT NOT NULL,
        size_bytes INTEGER,
        format TEXT,
        codec TEXT,
        resolution TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_local_files_work ON local_files(work_id);
      CREATE INDEX IF NOT EXISTS idx_local_files_path ON local_files(path);

      CREATE TABLE IF NOT EXISTS source_references (
        id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        source_url TEXT NOT NULL,
        provider_asset_id TEXT,
        raw_title TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_source_references_work ON source_references(work_id);

      CREATE TABLE IF NOT EXISTS identification_evidences (
        id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL,
        source TEXT NOT NULL,
        evidence_key TEXT,
        evidence_value TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_identification_evidences_work ON identification_evidences(work_id);
    `);
  }

  private mapLocalFileRow(f: RawLocalFileRow): LocalFileRecord {
    return {
      id: f.id,
      workId: f.work_id,
      path: f.path,
      ...(f.size_bytes !== null ? { sizeBytes: f.size_bytes } : {}),
      ...(f.format ? { format: f.format } : {}),
      ...(f.codec ? { codec: f.codec } : {}),
      ...(f.resolution ? { resolution: f.resolution } : {}),
    };
  }

  private mapPerformerRow(p: RawPerformerRow): PerformerRecord {
    return {
      id: p.id,
      name: p.name,
      ...(p.aliases_json ? { aliases: JSON.parse(p.aliases_json) } : {}),
      ...(p.date_of_birth ? { dateOfBirth: p.date_of_birth } : {}),
      ...(p.region ? { region: p.region } : {}),
    };
  }

  public recordConfirmedMedia(input: ConfirmedMediaInput): WorkRecord {
    const now = new Date().toISOString();
    const workId = randomUUID();

    // Work is Library Ready when it has confirmed identity (title + identifier) and an associated local file
    const isLibraryReady = Boolean(
      input.work.title &&
      input.work.identifiers.length > 0 &&
      input.localFile.path
    );

    // 1. Insert Work
    const insertWorkStmt = this.db.prepare(`
      INSERT INTO works (id, title, director, release_date, shoot_date, is_library_ready, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertWorkStmt.run(
      workId,
      input.work.title,
      input.work.director ?? null,
      input.work.releaseDate ?? null,
      input.work.shootDate ?? null,
      isLibraryReady ? 1 : 0,
      now,
      now
    );

    // 2. Insert Work Identifiers
    const insertIdentifierStmt = this.db.prepare(`
      INSERT OR IGNORE INTO work_identifiers (work_id, scheme, value)
      VALUES (?, ?, ?)
    `);
    for (const ident of input.work.identifiers) {
      insertIdentifierStmt.run(workId, ident.scheme, ident.value);
    }

    // 3. Upsert Performers & Link
    const findPerformerByNameStmt = this.db.prepare(`
      SELECT id, name, aliases_json, date_of_birth, region FROM performers WHERE name = ?
    `);
    const insertPerformerStmt = this.db.prepare(`
      INSERT INTO performers (id, name, aliases_json, date_of_birth, region)
      VALUES (?, ?, ?, ?, ?)
    `);
    const updatePerformerStmt = this.db.prepare(`
      UPDATE performers SET aliases_json = ?, date_of_birth = ?, region = ? WHERE id = ?
    `);
    const linkPerformerStmt = this.db.prepare(`
      INSERT OR IGNORE INTO work_performers (work_id, performer_id)
      VALUES (?, ?)
    `);

    for (const p of input.performers) {
      const existing = findPerformerByNameStmt.get(p.name) as RawPerformerRow | undefined;
      const performerId = existing ? existing.id : randomUUID();

      if (!existing) {
        insertPerformerStmt.run(
          performerId,
          p.name,
          p.aliases ? JSON.stringify(p.aliases) : null,
          p.dateOfBirth ?? null,
          p.region ?? null
        );
      } else {
        // Merge metadata without losing existing information
        let mergedAliases: string[] = existing.aliases_json ? JSON.parse(existing.aliases_json) : [];
        if (p.aliases && p.aliases.length > 0) {
          mergedAliases = Array.from(new Set([...mergedAliases, ...p.aliases]));
        }
        const updatedDob = p.dateOfBirth ?? existing.date_of_birth;
        const updatedRegion = p.region ?? existing.region;
        updatePerformerStmt.run(
          mergedAliases.length > 0 ? JSON.stringify(mergedAliases) : null,
          updatedDob ?? null,
          updatedRegion ?? null,
          existing.id
        );
      }
      linkPerformerStmt.run(workId, performerId);
    }

    // 4. Insert Local File
    const fileId = randomUUID();
    const insertFileStmt = this.db.prepare(`
      INSERT INTO local_files (id, work_id, path, size_bytes, format, codec, resolution)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    insertFileStmt.run(
      fileId,
      workId,
      input.localFile.path,
      input.localFile.sizeBytes ?? null,
      input.localFile.format ?? null,
      input.localFile.codec ?? null,
      input.localFile.resolution ?? null
    );

    // 5. Insert Source References
    if (input.sourceReferences && input.sourceReferences.length > 0) {
      const insertRefStmt = this.db.prepare(`
        INSERT INTO source_references (id, work_id, provider, source_url, provider_asset_id, raw_title)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const ref of input.sourceReferences) {
        insertRefStmt.run(
          randomUUID(),
          workId,
          ref.provider,
          ref.sourceUrl,
          ref.providerAssetId ?? null,
          ref.rawTitle ?? null
        );
      }
    }

    // 6. Insert Evidences
    if (input.evidences && input.evidences.length > 0) {
      const insertEvidenceStmt = this.db.prepare(`
        INSERT INTO identification_evidences (id, work_id, source, evidence_key, evidence_value, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const ev of input.evidences) {
        insertEvidenceStmt.run(
          randomUUID(),
          workId,
          ev.source,
          ev.evidenceKey ?? null,
          ev.evidenceValue,
          ev.recordedAt ?? now
        );
      }
    }

    const createdWork = this.getWork(workId);
    if (!createdWork) {
      throw new Error(`Failed to retrieve newly created work: ${workId}`);
    }
    return createdWork;
  }

  public getWork(workId: string): WorkRecord | null {
    const workRow = this.db
      .prepare(`
        SELECT id, title, director, release_date, shoot_date, is_library_ready
        FROM works
        WHERE id = ?
      `)
      .get(workId) as
      | {
          id: string;
          title: string;
          director: string | null;
          release_date: string | null;
          shoot_date: string | null;
          is_library_ready: number;
        }
      | undefined;

    if (!workRow) return null;

    // Identifiers
    const identifierRows = this.db
      .prepare(`SELECT scheme, value FROM work_identifiers WHERE work_id = ?`)
      .all(workId) as { scheme: string; value: string }[];

    // Performers
    const performerRows = this.db
      .prepare(`
        SELECT p.id, p.name, p.aliases_json, p.date_of_birth, p.region
        FROM performers p
        JOIN work_performers wp ON p.id = wp.performer_id
        WHERE wp.work_id = ?
      `)
      .all(workId) as unknown as RawPerformerRow[];

    const performers = performerRows.map((r) => this.mapPerformerRow(r));

    // Local Files
    const fileRows = this.db
      .prepare(`
        SELECT id, work_id, path, size_bytes, format, codec, resolution
        FROM local_files
        WHERE work_id = ?
      `)
      .all(workId) as unknown as RawLocalFileRow[];

    const localFiles = fileRows.map((f) => this.mapLocalFileRow(f));

    // Source References
    const refRows = this.db
      .prepare(`
        SELECT id, provider, source_url, provider_asset_id, raw_title
        FROM source_references
        WHERE work_id = ?
      `)
      .all(workId) as {
        id: string;
        provider: string;
        source_url: string;
        provider_asset_id: string | null;
        raw_title: string | null;
      }[];

    const sourceReferences: SourceReference[] = refRows.map((r) => ({
      id: r.id,
      provider: r.provider,
      sourceUrl: r.source_url,
      ...(r.provider_asset_id ? { providerAssetId: r.provider_asset_id } : {}),
      ...(r.raw_title ? { rawTitle: r.raw_title } : {}),
    }));

    // Identification Evidences
    const evRows = this.db
      .prepare(`
        SELECT source, evidence_key, evidence_value, recorded_at
        FROM identification_evidences
        WHERE work_id = ?
      `)
      .all(workId) as {
        source: string;
        evidence_key: string | null;
        evidence_value: string;
        recorded_at: string;
      }[];

    const evidences: IdentificationEvidence[] = evRows.map((e) => ({
      source: e.source,
      ...(e.evidence_key ? { evidenceKey: e.evidence_key } : {}),
      evidenceValue: e.evidence_value,
      recordedAt: e.recorded_at,
    }));

    return {
      id: workRow.id,
      title: workRow.title,
      identifiers: identifierRows,
      performers,
      sourceReferences,
      evidences,
      localFiles,
      isLibraryReady: Boolean(workRow.is_library_ready),
      ...(workRow.director ? { director: workRow.director } : {}),
      ...(workRow.release_date ? { releaseDate: workRow.release_date } : {}),
      ...(workRow.shoot_date ? { shootDate: workRow.shoot_date } : {}),
    };
  }

  public findWorkByIdentifier(value: string): WorkRecord | null;
  public findWorkByIdentifier(scheme: string, value: string): WorkRecord | null;
  public findWorkByIdentifier(schemeOrValue: string, maybeValue?: string): WorkRecord | null {
    let row: { work_id: string } | undefined;
    if (maybeValue !== undefined) {
      row = this.db
        .prepare(`SELECT work_id FROM work_identifiers WHERE scheme = ? AND value = ? LIMIT 1`)
        .get(schemeOrValue, maybeValue) as { work_id: string } | undefined;
    } else {
      row = this.db
        .prepare(`SELECT work_id FROM work_identifiers WHERE value = ? LIMIT 1`)
        .get(schemeOrValue) as { work_id: string } | undefined;
    }

    if (!row) return null;
    return this.getWork(row.work_id);
  }

  public getLocalFile(id: string): LocalFileRecord | null {
    const f = this.db
      .prepare(`
        SELECT id, work_id, path, size_bytes, format, codec, resolution
        FROM local_files
        WHERE id = ?
      `)
      .get(id) as RawLocalFileRow | undefined;

    if (!f) return null;
    return this.mapLocalFileRow(f);
  }

  public findLocalFileByPath(filePath: string): LocalFileRecord | null {
    const f = this.db
      .prepare(`
        SELECT id, work_id, path, size_bytes, format, codec, resolution
        FROM local_files
        WHERE path = ?
      `)
      .get(filePath) as RawLocalFileRow | undefined;

    if (!f) return null;
    return this.mapLocalFileRow(f);
  }

  public getPerformer(performerId: string): PerformerRecord | null {
    const p = this.db
      .prepare(`SELECT id, name, aliases_json, date_of_birth, region FROM performers WHERE id = ?`)
      .get(performerId) as RawPerformerRow | undefined;

    if (!p) return null;
    return this.mapPerformerRow(p);
  }
}
