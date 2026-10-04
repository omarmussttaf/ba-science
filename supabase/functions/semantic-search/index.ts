// BA Search v0.4 — Step 5
// Edge Function: semantic-search

// Type declaration for the Supabase Edge Runtime AI global.
// This declaration does not create or replace the runtime object.

declare const Supabase: {
  ai: {
    Session: new (model: string) => {
      run(
        input: string,
        options: {
          mean_pool: boolean;
          normalize: boolean;
        },
      ): Promise<ArrayLike<number>>;
    };
  };
};

const EMBEDDING_MODEL = "gte-small";
const DEFAULT_MATCH_COUNT = 12;
const DEFAULT_THRESHOLD = 0.45;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  if (request.method !== "POST") {
    return jsonResponse({ ok: false, error: "Method not allowed" }, 405);
  }

    // BA Security: Semantic Search is an internal service.
  // Reject unauthorized requests before running the AI model.

  const internalSecret = Deno.env.get(
    "BA_SEMANTIC_INTERNAL_SECRET",
  );

  if (!internalSecret) {
    console.error("BA Semantic: Internal secret is not configured.");

    return jsonResponse(
      {
        ok: false,
        error: "Semantic search is temporarily unavailable.",
      },
      503,
    );
  }

  const providedSecret = request.headers.get(
    "x-ba-semantic-secret",
  );

  if (!providedSecret || providedSecret !== internalSecret) {
    return jsonResponse(
      {
        ok: false,
        error: "Unauthorized semantic search request.",
      },
      401,
    );
  }
  try {
    const totalStartedAt = performance.now();
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !serviceRoleKey) {
      return jsonResponse(
        { ok: false, error: "Missing Supabase server credentials." },
        500,
      );
    }

    const body = await readJsonBody(request);

    const query =
      typeof body?.query === "string"
        ? body.query.trim()
        : "";

    if (!query) {
      return jsonResponse(
        { ok: false, error: "Missing query." },
        400,
      );
    }

    const matchCount = clampInteger(
      body?.match_count,
      1,
      30,
      DEFAULT_MATCH_COUNT,
    );

    const threshold = clampNumber(
      body?.match_threshold,
      0,
      1,
      DEFAULT_THRESHOLD,
    );
    // BA Science — Semantic Performance Metrics
    const inferenceStartedAt = performance.now();

    const session = new Supabase.ai.Session(EMBEDDING_MODEL);

    const output = await session.run(query, {
      mean_pool: true,
      normalize: true,
    });

    const inferenceMs = Math.round(
      performance.now() - inferenceStartedAt,
    );

    console.log("BA SEMANTIC inferenceMs:", inferenceMs);


    const queryEmbedding = Array.from(
      output as ArrayLike<number>,
    );

    if (queryEmbedding.length !== 384) {
      throw new Error(
        `Unexpected embedding dimensions: ${queryEmbedding.length}`,
      );
    }

    const databaseStartedAt = performance.now();
    const results = await callMatchPapersRpc(
      supabaseUrl,
      serviceRoleKey,
      queryEmbedding,
      matchCount,
      threshold,
    );

    const databaseMs = Math.round(
      performance.now() - databaseStartedAt,
    );

    console.log("BA SEMANTIC databaseMs:", databaseMs);

    const totalMs = Math.round(
      performance.now() - totalStartedAt,
    );

    console.log("BA SEMANTIC totalMs:", totalMs);



    return jsonResponse({
      ok: true,
      query,
      model: EMBEDDING_MODEL,
      dimensions: queryEmbedding.length,
      matchCount: results.length,
      threshold,
      results,
    });
  } catch (error) {
    console.error("semantic-search error:", error);

    return jsonResponse(
      {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Unknown semantic search error.",
      },
      500,
    );
  }
});

async function callMatchPapersRpc(
  supabaseUrl: string,
  serviceRoleKey: string,
  queryEmbedding: number[],
  matchCount: number,
  threshold: number,
) {
  const rpcFetchStartedAt = performance.now();

  const response = await fetch(
    `${supabaseUrl}/rest/v1/rpc/match_ba_papers`,
    {
      method: "POST",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query_embedding: queryEmbedding,
        match_count: matchCount,
        match_threshold: threshold,
      }),
    },
  );

  console.log(
    "BA SEMANTIC rpcFetchMs:",
    Math.round(performance.now() - rpcFetchStartedAt),
  );

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `match_ba_papers RPC failed (${response.status}): ${errorBody.slice(0, 700)}`,
    );
  }

  const rpcParseStartedAt = performance.now();
  const rows = await response.json();

  console.log(
    "BA SEMANTIC rpcParseMs:",
    Math.round(performance.now() - rpcParseStartedAt),
  );

  if (!Array.isArray(rows)) {
    return [];
  }

  return rows.map((row) => ({
    ...row,
    semantic_similarity:
      typeof row?.semantic_similarity === "number"
        ? Number(row.semantic_similarity.toFixed(4))
        : row?.semantic_similarity,
  }));
}

async function readJsonBody(request: Request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function clampInteger(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;

  return Math.min(
    max,
    Math.max(min, Math.round(parsed)),
  );
}

function clampNumber(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;

  return Math.min(
    max,
    Math.max(min, parsed),
  );
}

function jsonResponse(
  payload: unknown,
  status = 200,
) {
  return new Response(
    JSON.stringify(payload, null, 2),
    {
      status,
      headers: {
        ...CORS_HEADERS,
        "Content-Type":
          "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
    },
  );
}
