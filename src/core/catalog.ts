import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type {
  PerformerRecord,
  WorkIdentifier,
  IdentificationEvidence,
  SourceReference,
  LocalFileRecord,
  ReviewCandidateRecord,
  WorkRecord,
  PerformerInput,
  SourceReferenceInput,
  IdentificationEvidenceInput,
  PendingMediaInput,
  ReviewResolutionInput,
  ConfirmedMediaInput,
} from "./catalog-types.js";

export * from "./catalog-types.js";

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

interface RawWorkRow {
  id: string;
  title: string;
  director: string | null;
  release_date: string | null;
  shoot_date: string | null;
  is_library_ready: number;
  review_status: string | null;
  review_reason: string | null;
}

interface RawReviewCandidateRow {
  title: string;
  studio: string | null;
  director: string | null;
  release_date: string | null;
  shoot_date: string | null;
  identifiers_json: string;
  performers_json: string;
  source_references_json: string;
  evidences_json: string | null;
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
        review_status TEXT,
        review_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_works_library_ready ON works(is_library_ready);

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
        source_url TEXT,
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

      CREATE TABLE IF NOT EXISTS review_candidates (
        id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL,
        candidate_index INTEGER NOT NULL,
        title TEXT NOT NULL,
        studio TEXT,
        director TEXT,
        release_date TEXT,
        shoot_date TEXT,
        identifiers_json TEXT,
        performers_json TEXT,
        source_references_json TEXT,
        evidences_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_review_candidates_work ON review_candidates(work_id);
    `);

    // Migration compatibility: ensure review_status and review_reason exist if table already existed
    const cols = this.db.prepare("PRAGMA table_info(works)").all() as { name: string }[];
    const colNames = new Set(cols.map((c) => c.name));
    if (!colNames.has("review_status")) {
      this.db.exec("ALTER TABLE works ADD COLUMN review_status TEXT;");
    }
    if (!colNames.has("review_reason")) {
      this.db.exec("ALTER TABLE works ADD COLUMN review_reason TEXT;");
    }
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

  private validateMediaInput(
    title?: string,
    filePath?: string,
    errorPrefix = "Invalid media input"
  ): { trimmedTitle: string; trimmedFilePath: string } {
    const trimmedTitle = title?.trim();
    if (!trimmedTitle) {
      throw new Error(`${errorPrefix}: Work title is required.`);
    }
    const trimmedFilePath = filePath?.trim();
    if (!trimmedFilePath) {
      throw new Error(`${errorPrefix}: Local file path is required.`);
    }
    return { trimmedTitle, trimmedFilePath };
  }

  private persistWorkIdentifiers(workId: string, identifiers?: WorkIdentifier[]): void {
    if (!identifiers || identifiers.length === 0) return;
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO work_identifiers (work_id, scheme, value) VALUES (?, ?, ?)`
    );
    for (const ident of identifiers) {
      stmt.run(workId, ident.scheme, ident.value);
    }
  }

  private persistPerformers(workId: string, performers?: PerformerInput[]): void {
    if (!performers || performers.length === 0) return;
    const insertStmt = this.db.prepare(
      `INSERT INTO performers (id, name, aliases_json, date_of_birth, region) VALUES (?, ?, ?, ?, ?)`
    );
    const linkStmt = this.db.prepare(
      `INSERT OR IGNORE INTO work_performers (work_id, performer_id) VALUES (?, ?)`
    );
    for (const p of performers) {
      const performerId = randomUUID();
      insertStmt.run(
        performerId,
        p.name,
        p.aliases ? JSON.stringify(p.aliases) : null,
        p.dateOfBirth ?? null,
        p.region ?? null
      );
      linkStmt.run(workId, performerId);
    }
  }

  private persistSourceReferences(workId: string, refs?: SourceReferenceInput[]): void {
    if (!refs || refs.length === 0) return;
    const stmt = this.db.prepare(
      `INSERT INTO source_references (id, work_id, provider, source_url, provider_asset_id, raw_title) VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const ref of refs) {
      stmt.run(
        randomUUID(),
        workId,
        ref.provider,
        ref.sourceUrl ?? null,
        ref.providerAssetId ?? null,
        ref.rawTitle ?? null
      );
    }
  }

  private persistEvidences(
    workId: string,
    evidences?: IdentificationEvidenceInput[],
    defaultRecordedAt?: string
  ): void {
    if (!evidences || evidences.length === 0) return;
    const stmt = this.db.prepare(
      `INSERT INTO identification_evidences (id, work_id, source, evidence_key, evidence_value, recorded_at) VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const ev of evidences) {
      stmt.run(
        randomUUID(),
        workId,
        ev.source,
        ev.evidenceKey ?? null,
        ev.evidenceValue,
        ev.recordedAt ?? defaultRecordedAt ?? new Date().toISOString()
      );
    }
  }

  private persistReviewCandidates(workId: string, candidates?: ReviewCandidateRecord[]): void {
    if (!candidates || candidates.length === 0) return;
    const stmt = this.db.prepare(`
      INSERT INTO review_candidates (
        id, work_id, candidate_index, title, studio, director, release_date, shoot_date,
        identifiers_json, performers_json, source_references_json, evidences_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const now = new Date().toISOString();
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      stmt.run(
        randomUUID(),
        workId,
        i,
        c.title,
        c.studio ?? null,
        c.director ?? null,
        c.releaseDate ?? null,
        c.shootDate ?? null,
        JSON.stringify(c.identifiers || []),
        JSON.stringify(c.performers || []),
        JSON.stringify(c.sourceReferences || []),
        c.evidences ? JSON.stringify(c.evidences) : null,
        now
      );
    }
  }

  private insertMedia(
    input: PendingMediaInput,
    trimmedTitle: string,
    trimmedFilePath: string,
    isLibraryReady: boolean,
    reviewStatus: "ready" | "pending_review" | "query_failed",
    reviewReason: string | null
  ): WorkRecord {
    const now = new Date().toISOString();
    const workId = randomUUID();

    // 1. Insert Work
    this.db
      .prepare(
        `INSERT INTO works (id, title, director, release_date, shoot_date, is_library_ready, review_status, review_reason, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        workId,
        trimmedTitle,
        input.work.director ?? null,
        input.work.releaseDate ?? null,
        input.work.shootDate ?? null,
        isLibraryReady ? 1 : 0,
        reviewStatus,
        reviewReason,
        now,
        now
      );

    // 2. Insert Work Identifiers
    this.persistWorkIdentifiers(workId, input.work.identifiers);

    // 3. Insert Performers & Link
    this.persistPerformers(workId, input.performers);

    // 4. Insert Local File
    const fileId = randomUUID();
    this.db
      .prepare(
        `INSERT INTO local_files (id, work_id, path, size_bytes, format, codec, resolution)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        fileId,
        workId,
        trimmedFilePath,
        input.localFile.sizeBytes ?? null,
        input.localFile.format ?? null,
        input.localFile.codec ?? null,
        input.localFile.resolution ?? null
      );

    // 5. Insert Source References
    this.persistSourceReferences(workId, input.sourceReferences);

    // 6. Insert Evidences
    this.persistEvidences(workId, input.evidences, now);

    // 7. Insert Review Candidates (durable across restarts for pending reviews)
    this.persistReviewCandidates(workId, input.reviewCandidates);

    const createdWork = this.getWork(workId);
    if (!createdWork) {
      throw new Error(`Failed to retrieve newly created work: ${workId}`);
    }
    return createdWork;
  }

  public recordConfirmedMedia(input: ConfirmedMediaInput): WorkRecord {
    const { trimmedTitle, trimmedFilePath } = this.validateMediaInput(
      input.work?.title,
      input.localFile?.path,
      "Invalid confirmed media"
    );
    return this.insertMedia(input, trimmedTitle, trimmedFilePath, true, "ready", null);
  }

  public recordPendingMedia(input: PendingMediaInput): WorkRecord {
    const { trimmedTitle, trimmedFilePath } = this.validateMediaInput(
      input.work?.title,
      input.localFile?.path,
      "Invalid pending media"
    );
    const status = input.reviewStatus ?? "pending_review";
    return this.insertMedia(
      input,
      trimmedTitle,
      trimmedFilePath,
      false,
      status,
      input.reviewReason ?? null
    );
  }

  public resolveReview(workId: string, resolution: ReviewResolutionInput): WorkRecord {
    const existing = this.getWork(workId);
    if (!existing) {
      throw new Error(`Cannot resolve review: Work not found: ${workId}`);
    }

    const now = new Date().toISOString();

    // 1. Update works table
    this.db
      .prepare(
        `UPDATE works
         SET title = COALESCE(?, title),
             director = COALESCE(?, director),
             release_date = COALESCE(?, release_date),
             shoot_date = COALESCE(?, shoot_date),
             is_library_ready = 1,
             review_status = 'ready',
             review_reason = NULL,
             updated_at = ?
         WHERE id = ?`
      )
      .run(
        resolution.title ?? null,
        resolution.director ?? null,
        resolution.releaseDate ?? null,
        resolution.shootDate ?? null,
        now,
        workId
      );

    // 2. Replace unconfirmed identifiers with confirmed identifiers if provided
    if (resolution.identifiers && resolution.identifiers.length > 0) {
      this.db.prepare("DELETE FROM work_identifiers WHERE work_id = ?").run(workId);
      this.persistWorkIdentifiers(workId, resolution.identifiers);
    }

    // 3. Replace unconfirmed performers with confirmed performers if provided
    if (resolution.performers && resolution.performers.length > 0) {
      this.db.prepare("DELETE FROM work_performers WHERE work_id = ?").run(workId);
      this.persistPerformers(workId, resolution.performers);
    }

    // 4. Insert source references
    this.persistSourceReferences(workId, resolution.sourceReferences);

    // 5. Clean up pending review candidates
    this.db.prepare("DELETE FROM review_candidates WHERE work_id = ?").run(workId);

    // 6. Insert evidence of manual correction
    this.persistEvidences(
      workId,
      [
        {
          source: "user-manual-correction",
          evidenceKey: "resolution",
          evidenceValue: resolution.notes ?? JSON.stringify(resolution),
          recordedAt: now,
        },
      ],
      now
    );

    const updated = this.getWork(workId);
    if (!updated) {
      throw new Error(`Failed to retrieve work after resolving review: ${workId}`);
    }
    return updated;
  }

  public getPendingReviews(): WorkRecord[] {
    const rows = this.db
      .prepare(`SELECT id FROM works WHERE is_library_ready = 0 ORDER BY updated_at DESC`)
      .all() as { id: string }[];
    return rows.map((r) => this.getWork(r.id)!).filter(Boolean);
  }

  public getWork(workId: string): WorkRecord | null {
    const workRow = this.db
      .prepare(`
        SELECT id, title, director, release_date, shoot_date, is_library_ready, review_status, review_reason
        FROM works
        WHERE id = ?
      `)
      .get(workId) as RawWorkRow | undefined;

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

    // Review Candidates (if in review queue)
    const candidateRows = this.db
      .prepare(`
        SELECT title, studio, director, release_date, shoot_date, identifiers_json, performers_json, source_references_json, evidences_json
        FROM review_candidates
        WHERE work_id = ?
        ORDER BY candidate_index ASC
      `)
      .all(workId) as unknown as RawReviewCandidateRow[];

    const reviewCandidates: ReviewCandidateRecord[] = candidateRows.map((r) => ({
      title: r.title,
      ...(r.studio ? { studio: r.studio } : {}),
      ...(r.director ? { director: r.director } : {}),
      ...(r.release_date ? { releaseDate: r.release_date } : {}),
      ...(r.shoot_date ? { shootDate: r.shoot_date } : {}),
      identifiers: JSON.parse(r.identifiers_json),
      performers: JSON.parse(r.performers_json),
      sourceReferences: JSON.parse(r.source_references_json),
      ...(r.evidences_json ? { evidences: JSON.parse(r.evidences_json) } : {}),
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
      ...(workRow.review_status ? { reviewStatus: workRow.review_status as any } : {}),
      ...(workRow.review_reason ? { reviewReason: workRow.review_reason } : {}),
      ...(reviewCandidates.length > 0 ? { reviewCandidates } : {}),
      ...(workRow.director ? { director: workRow.director } : {}),
      ...(workRow.release_date ? { releaseDate: workRow.release_date } : {}),
      ...(workRow.shoot_date ? { shootDate: workRow.shoot_date } : {}),
    };
  }

  public findWorkByIdentifier(identifier: WorkIdentifier): WorkRecord | null;
  public findWorkByIdentifier(scheme: string, value: string): WorkRecord | null;
  public findWorkByIdentifier(
    schemeOrIdentifier: string | WorkIdentifier,
    maybeValue?: string
  ): WorkRecord | null {
    const scheme =
      typeof schemeOrIdentifier === "string"
        ? schemeOrIdentifier
        : schemeOrIdentifier.scheme;
    const value =
      typeof schemeOrIdentifier === "string"
        ? maybeValue!
        : schemeOrIdentifier.value;

    const row = this.db
      .prepare(`SELECT work_id FROM work_identifiers WHERE scheme = ? AND value = ? LIMIT 1`)
      .get(scheme, value) as { work_id: string } | undefined;

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
