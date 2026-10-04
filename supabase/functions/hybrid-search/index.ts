// BA Search v0.4.0 — Evidence-Aware Final Ranking
// Edge Function: hybrid-search
//
// Purpose:
//   Run the stable BA lexical search and the semantic memory search
//   in parallel, then merge them into one hybrid ranking.
//
// IMPORTANT:
//   - research-search remains unchanged and stable.
//   - semantic-search remains separate.
//   - v0.4.0 adds evidence-aware final reranking and calibrated display scores.
//   - BA Score remains a search-relevance score, not a measure of scientific quality.

const LEXICAL_WEIGHT = 0.80;
const SEMANTIC_WEIGHT = 0.20;
const SEMANTIC_ONLY_SCALE = 70;
const SEMANTIC_ONLY_MIN_SIMILARITY = 0.72;
const SEMANTIC_ONLY_HARD_CAP = 76;
const SEMANTIC_ONLY_MIN_ANCHOR_COVERAGE = 0.34;

// Final-ranking calibration. These values are deliberately bounded:
// the lexical + semantic retrieval score remains the foundation.
const FINAL_TOPIC_ADJUSTMENT_LIMIT = 8;
const FINAL_CONSTRAINT_ADJUSTMENT_LIMIT = 12;
const FINAL_INTEGRITY_PENALTY = -22;
const DISPLAY_SCORE_MAX = 99;
const DISPLAY_SCORE_MIN = 35;

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
    return jsonResponse(
      { ok: false, error: "Method not allowed" },
      405,
    );
  }

  try {
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

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey =
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !serviceRoleKey) {
      return jsonResponse(
        {
          ok: false,
          error: "Missing Supabase server credentials.",
        },
        500,
      );
    }

    const headers: Record<string, string> = {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
    };

    // Preserve the original visitor authorization separately.
    // Research must verify the token through Supabase Auth.
    // Never treat this header as a verified user identity.

    const visitorAuthorization =
      request.headers.get("authorization");

    if (visitorAuthorization) {
      headers["x-ba-visitor-authorization"] =
        visitorAuthorization;
    }


    // STEP 1: Run lexical search first.
    // This request enforces BA Search Rate Limiting.

    const lexicalResponse = await fetch(
      `${supabaseUrl}/functions/v1/research-search`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ query }),
      },
    );

    const lexicalPayload =
      await safeJson(lexicalResponse);

    // Stop if research-search rejects the request.
    // HTTP 429 must not trigger semantic-search.

    if (!lexicalResponse.ok) {
      return jsonResponse(
        {
          ok: false,
          error: "research-search failed",
          details: lexicalPayload,
        },
        lexicalResponse.status,
      );
    }

    // STEP 2: Optional live semantic search.
    // Disabled by default until AI inference performance is resolved.

    const liveSemanticEnabled =
      Deno.env.get("BA_ENABLE_LIVE_SEMANTIC") === "true";

    let semanticResponse: Response | null = null;
    let semanticPayload: any = null;

    if (liveSemanticEnabled) {

      // BA Security: Internal authorization.

      const semanticInternalSecret = Deno.env.get(
        "BA_SEMANTIC_INTERNAL_SECRET",
      );

      if (!semanticInternalSecret) {
        console.warn(
          "BA Hybrid: Semantic secret is missing; using lexical fallback.",
        );
      } else {

        // BA Reliability: Limit how long Hybrid waits for AI.

        try {
          semanticResponse = await fetch(
            `${supabaseUrl}/functions/v1/semantic-search`,
            {
              method: "POST",
              headers: {
                apikey: serviceRoleKey,
                Authorization: `Bearer ${serviceRoleKey}`,
                "Content-Type": "application/json",
                "x-ba-semantic-secret": semanticInternalSecret,
              },
              body: JSON.stringify({
                query,
                match_count: 20,
                match_threshold: 0.45,
              }),
              signal: AbortSignal.timeout(12_000),
            },
          );

          semanticPayload = await safeJson(semanticResponse);

        } catch (error) {
          console.warn(
            "BA Hybrid: Semantic Search failed or timed out.",
            error instanceof Error ? error.name : "Unknown error",
          );
        }
      }
    }

    // Semantic search is optional. If it fails, keep the v0.3.9 lexical retrieval and still apply v0.4.0 final reranking.
    if (!semanticResponse?.ok || semanticPayload?.ok !== true) {
      return jsonResponse({
        ok: true,
        mode: "lexical-fallback",
        query,
        semanticApplied: false,
        lexicalCount:
          Array.isArray(lexicalPayload?.results)
            ? lexicalPayload.results.length
            : 0,
        semanticCount: 0,
        results:
          Array.isArray(lexicalPayload?.results)
            ? finalizeHybridRanking(
                lexicalPayload.results.map(
                  (item: any) => ({
                    ...item,
                    lexicalBaScore:
                      Number(item.baScore ?? 0),
                    semanticSimilarity: null,
                    rawHybridScore:
                      Number(item.baScore ?? 0),
                    hybridScore:
                      Number(item.baScore ?? 0),
                    hybridOrigin: "lexical",
                  }),
                ),
                query,
              ).slice(0, 60)
            : [],
        rankingVersion: "v0.4.0",
      });
    }

    const lexicalResults =
      Array.isArray(lexicalPayload?.results)
        ? lexicalPayload.results
        : [];

    const semanticResults =
      Array.isArray(semanticPayload?.results)
        ? semanticPayload.results
        : [];

    const semanticIndex =
      buildSemanticIndex(semanticResults);

    const usedSemanticKeys =
      new Set<string>();

    let matchedBothCount = 0;

    const merged = lexicalResults.map(
      (item: any) => {
        const semanticMatch =
          findSemanticMatch(item, semanticIndex);

        if (!semanticMatch) {
          return {
            ...item,
            lexicalBaScore:
              Number(item.baScore ?? 0),
            semanticSimilarity: null,
            rawHybridScore:
              Number(item.baScore ?? 0),
            hybridScore:
              Number(item.baScore ?? 0),
            hybridOrigin: "lexical",
          };
        }

        const semanticSimilarity =
          Number(
            semanticMatch.semantic_similarity ?? 0,
          );

        const baseScore =
          Number(item.baScore ?? 0);

        const rawHybridScore =
          (
            baseScore *
            LEXICAL_WEIGHT
          ) +
          (
            semanticSimilarity *
            100 *
            SEMANTIC_WEIGHT
          );

        const hybridScore =
          Math.round(
            rawHybridScore,
          );

        usedSemanticKeys.add(
          semanticKey(semanticMatch),
        );

        matchedBothCount += 1;

        return {
          ...item,
          lexicalBaScore: baseScore,
          semanticSimilarity,
          rawHybridScore,
          hybridScore,
          hybridOrigin: "both",
        };
      },
    );

    // Add semantic-memory results that live keyword retrieval missed,
    // but prevent broad semantic matches from outranking strong lexical hits.
    for (const item of semanticResults) {
      const key = semanticKey(item);

      if (!key || usedSemanticKeys.has(key)) {
        continue;
      }

      const semanticSimilarity =
        Number(item.semantic_similarity ?? 0);

      if (
        semanticSimilarity <
        SEMANTIC_ONLY_MIN_SIMILARITY
      ) {
        continue;
      }

      const titleCoverage =
        calculateLightweightTitleCoverage(
          query,
          String(item.title ?? ""),
        );

      const anchorCoverage =
        calculateDomainAnchorCoverage(
          query,
          [
            String(item.title ?? ""),
            String(item.abstract ?? ""),
          ].join(" "),
        );

      /*
        Semantic-only candidates need either:
        - some direct title support, or
        - an exceptionally strong semantic match.
        This keeps "conceptually nearby" but off-intent papers from
        jumping above papers that directly answer the query.
      */
      if (
        anchorCoverage <
          SEMANTIC_ONLY_MIN_ANCHOR_COVERAGE &&
        semanticSimilarity < 0.93
      ) {
        continue;
      }

      if (
        titleCoverage < 0.15 &&
        anchorCoverage < 0.67 &&
        semanticSimilarity < 0.90
      ) {
        continue;
      }

      const citationBonus =
        Math.min(
          3,
          Math.log10(
            Number(item.cited_by_count ?? 0) + 1,
          ) * 0.9,
        );

      const rawSemanticOnlyScore =
        (
          semanticSimilarity *
          SEMANTIC_ONLY_SCALE
        ) +
        (
          titleCoverage *
          12
        ) +
        (
          anchorCoverage *
          10
        ) +
        citationBonus;

      const rawHybridScore =
        Math.min(
          SEMANTIC_ONLY_HARD_CAP,
          rawSemanticOnlyScore,
        );

      const hybridScore =
        Math.round(
          rawHybridScore,
        );

      merged.push({
        key:
          item.canonical_key ?? key,
        openAlexId:
          item.openalex_id ?? null,
        doi:
          item.doi ?? null,
        title:
          item.title ?? "",
        authors:
          Array.isArray(item.authors)
            ? item.authors
            : [],
        year:
          item.publication_year ?? null,
        sourceName:
          item.journal_name ?? "",
        documentType:
          item.document_type ?? "unknown",
        citedByCount:
          Number(item.cited_by_count ?? 0),
        isOpenAccess:
          Boolean(item.is_open_access),
        url:
          item.source_url ?? null,
        abstract:
          item.abstract ?? "",
        sources:
          Array.isArray(item.sources)
            ? item.sources
            : ["BA Memory"],

        lexicalBaScore: null,
        semanticSimilarity,
        semanticTitleCoverage: titleCoverage,
        semanticAnchorCoverage: anchorCoverage,
        rawHybridScore,
        hybridScore,
        baScore: hybridScore,
        hybridOrigin: "semantic-memory",
      });
      usedSemanticKeys.add(key);
    }

    const results =
      finalizeHybridRanking(
        merged,
        query,
      ).slice(0, 60);

    return jsonResponse({
      ok: true,
      mode: "hybrid-v0.4",
      rankingVersion: "v0.4.0",
      query,
      semanticApplied: true,
      weights: {
        lexical: LEXICAL_WEIGHT,
        semantic: SEMANTIC_WEIGHT,
      },
      lexicalCount: lexicalResults.length,
      semanticCount: semanticResults.length,
      matchedBothCount,
      semanticMemoryCoverage:
        lexicalResults.length > 0
          ? Number(
              (
                matchedBothCount /
                lexicalResults.length
              ).toFixed(3),
            )
          : 0,
      count: results.length,
      results,
    });
  } catch (error) {
    console.error("hybrid-search error:", error);

    return jsonResponse(
      {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Unknown hybrid search error.",
      },
      500,
    );
  }
});

function buildSemanticIndex(
  results: any[],
) {
  const map =
    new Map<string, any>();

  for (const item of results) {
    for (const key of candidateKeys(item)) {
      if (key && !map.has(key)) {
        map.set(key, item);
      }
    }
  }

  return map;
}

function findSemanticMatch(
  lexicalItem: any,
  semanticIndex: Map<string, any>,
) {
  for (const key of candidateKeys(lexicalItem)) {
    const match =
      semanticIndex.get(key);

    if (match) {
      return match;
    }
  }

  return null;
}

function candidateKeys(
  item: any,
) {
  const keys: string[] = [];

  const doi =
    normalizeDoi(
      item?.doi,
    );

  if (doi) {
    keys.push(`doi:${doi}`);
  }

  const openAlexId =
    String(
      item?.openAlexId ??
      item?.openalex_id ??
      "",
    )
      .trim();

  if (openAlexId) {
    keys.push(
      `openalex:${openAlexId}`,
    );
  }

  const canonical =
    String(
      item?.canonical_key ??
      item?.key ??
      "",
    )
      .trim();

  if (canonical) {
    keys.push(
      `canonical:${canonical.toLowerCase()}`,
    );
  }

  const title =
    titleFingerprint(
      item?.title,
    );

  if (title) {
    keys.push(
      `title:${title}`,
    );
  }

  return keys;
}

function semanticKey(
  item: any,
) {
  return (
    candidateKeys(item)[0] ||
    ""
  );
}

function normalizeDoi(
  value: unknown,
) {
  if (
    typeof value !== "string"
  ) {
    return "";
  }

  return value
    .trim()
    .toLowerCase()
    .replace(
      /^https?:\/\/(dx\.)?doi\.org\//,
      "",
    )
    .replace(
      /^doi:\s*/,
      "",
    );
}

function titleFingerprint(
  value: unknown,
) {
  if (
    typeof value !== "string"
  ) {
    return "";
  }

  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(
      /[\u0300-\u036f]/g,
      "",
    )
    .replace(
      /[^a-z0-9]+/g,
      " ",
    )
    .trim()
    .replace(
      /\s+/g,
      " ",
    );
}



function calculateDomainAnchorCoverage(
  query: string,
  documentText: string,
) {
  const stopWords =
    new Set([
      "a",
      "an",
      "and",
      "are",
      "as",
      "at",
      "by",
      "for",
      "from",
      "in",
      "into",
      "of",
      "on",
      "or",
      "the",
      "to",
      "using",
      "with",
      "method",
      "methods",
      "protect",
      "protecting",
      "protection",
      "study",
      "studies",
      "approach",
      "approaches",
      "model",
      "models",
      "system",
      "systems",
    ]);

  const queryTokens =
    query
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .split(/\s+/)
      .filter(
        (token) =>
          token.length >= 4 &&
          !stopWords.has(token),
      );

  if (queryTokens.length === 0) {
    return 0;
  }

  const textTokens =
    new Set(
      documentText
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
        .split(/\s+/)
        .filter(Boolean),
    );

  let matched = 0;

  for (const token of queryTokens) {
    if (textTokens.has(token)) {
      matched += 1;
    }
  }

  return Math.min(
    1,
    matched /
    queryTokens.length,
  );
}


function calculateLightweightTitleCoverage(
  query: string,
  title: string,
) {
  const stopWords =
    new Set([
      "a",
      "an",
      "and",
      "are",
      "as",
      "at",
      "by",
      "for",
      "from",
      "in",
      "into",
      "of",
      "on",
      "or",
      "the",
      "to",
      "using",
      "with",
      "method",
      "methods",
    ]);

  const queryTokens =
    query
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .split(/\s+/)
      .filter(
        (token) =>
          token &&
          !stopWords.has(token),
      );

  if (queryTokens.length === 0) {
    return 0;
  }

  const titleTokens =
    new Set(
      title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
        .split(/\s+/)
        .filter(Boolean),
    );

  let matched = 0;

  for (const token of queryTokens) {
    if (titleTokens.has(token)) {
      matched += 1;
    }
  }

  return Math.min(
    1,
    matched /
    queryTokens.length,
  );
}



/* =========================================================
   BA v0.4.0 — EVIDENCE-AWARE FINAL RANKING

   Retrieval and ranking are intentionally separated:

   1) research-search provides lexical/scientific relevance.
   2) semantic-search provides meaning-level support.
   3) this layer resolves close calls using explicit user intent,
      title centrality, topic breadth, and record integrity.
   4) the displayed BA Score is calibrated separately so that
      many excellent papers do not collapse to 100/100.

   This layer does NOT judge scientific quality.
========================================================= */

type FinalQueryIntent = {
  topicTokens: string[];
  requestedDocumentType:
    | "systematic-review"
    | "meta-analysis"
    | "review"
    | "preprint"
    | "article"
    | null;
  openAccessRequested: boolean;
};


function finalizeHybridRanking(
  candidates: any[],
  query: string,
) {
  const intent =
    analyzeFinalQueryIntent(query);

  const enriched =
    candidates.map(
      (item: any) => {
        const signals =
          calculateFinalRankingSignals(
            item,
            intent,
          );

        const rawHybridScore =
          Number(
            item.rawHybridScore ??
            item.hybridScore ??
            item.baScore ??
            0,
          );

        const finalRankingScore =
          rawHybridScore +
          signals.topicAdjustment +
          signals.coreTitleBonus +
          signals.conceptBalanceAdjustment +
          signals.documentConstraintAdjustment +
          signals.accessConstraintAdjustment +
          signals.integrityAdjustment +
          signals.citationTieBreak;

        return {
          ...item,
          rawHybridScore:
            Number(
              rawHybridScore.toFixed(3),
            ),
          finalRankingScore:
            Number(
              finalRankingScore.toFixed(3),
            ),
          rankingSignals: {
            titleCoverage:
              Number(
                signals.titleCoverage.toFixed(3),
              ),
            titleFocus:
              Number(
                signals.titleFocus.toFixed(3),
              ),
            bodyCoverage:
              Number(
                signals.bodyCoverage.toFixed(3),
              ),
            topicCentrality:
              Number(
                signals.topicCentrality.toFixed(3),
              ),
            conceptBalance:
              Number(
                signals.conceptBalance.toFixed(3),
              ),
            topicAdjustment:
              Number(
                signals.topicAdjustment.toFixed(3),
              ),
            coreTitleBonus:
              signals.coreTitleBonus,
            conceptBalanceAdjustment:
              Number(
                signals.conceptBalanceAdjustment.toFixed(3),
              ),
            documentConstraintAdjustment:
              signals.documentConstraintAdjustment,
            accessConstraintAdjustment:
              signals.accessConstraintAdjustment,
            integrityAdjustment:
              signals.integrityAdjustment,
            citationTieBreak:
              Number(
                signals.citationTieBreak.toFixed(3),
              ),
          },
        };
      },
    );

  enriched.sort(
    (a: any, b: any) => {
      const finalDifference =
        Number(b.finalRankingScore ?? 0) -
        Number(a.finalRankingScore ?? 0);

      if (
        Math.abs(finalDifference) >
        0.0001
      ) {
        return finalDifference;
      }

      const rawDifference =
        Number(b.rawHybridScore ?? 0) -
        Number(a.rawHybridScore ?? 0);

      if (
        Math.abs(rawDifference) >
        0.0001
      ) {
        return rawDifference;
      }

      return (
        Number(b.citedByCount ?? 0) -
        Number(a.citedByCount ?? 0)
      );
    },
  );

  return calibrateDisplayScores(
    enriched,
  );
}


function analyzeFinalQueryIntent(
  query: string,
): FinalQueryIntent {
  const normalized =
    normalizeScientificText(query);

  let requestedDocumentType:
    FinalQueryIntent["requestedDocumentType"] =
      null;

  if (
    /\bsystematic\s+review\b/.test(
      normalized,
    )
  ) {
    requestedDocumentType =
      "systematic-review";
  }
  else if (
    /\bmeta\s+analysis\b/.test(
      normalized,
    )
  ) {
    requestedDocumentType =
      "meta-analysis";
  }
  else if (
    /\breview\b/.test(
      normalized,
    ) &&
    !/\bpeer\s+review\b/.test(
      normalized,
    )
  ) {
    requestedDocumentType =
      "review";
  }
  else if (
    /\bpreprint\b/.test(
      normalized,
    )
  ) {
    requestedDocumentType =
      "preprint";
  }
  else if (
    /\barticle\b/.test(
      normalized,
    )
  ) {
    requestedDocumentType =
      "article";
  }

  return {
    topicTokens:
      getFinalTopicTokens(query),
    requestedDocumentType,
    openAccessRequested:
      /\bopen\s+access\b/.test(
        normalized,
      ),
  };
}


function calculateFinalRankingSignals(
  item: any,
  intent: FinalQueryIntent,
) {
  const title =
    String(item?.title ?? "");

  const abstract =
    String(item?.abstract ?? "");

  const titleTokens =
    getFinalMeaningfulTokens(title);

  const titleSet =
    new Set(titleTokens);

  const bodySet =
    new Set(
      tokenizeScientificText(
        [title, abstract]
          .filter(Boolean)
          .join(" "),
      ),
    );

  const topicTokens =
    intent.topicTokens;

  const matchedInTitle =
    topicTokens.filter(
      (token) =>
        titleSet.has(token),
    ).length;

  const matchedInBody =
    topicTokens.filter(
      (token) =>
        bodySet.has(token),
    ).length;

  const titleCoverage =
    topicTokens.length > 0
      ? matchedInTitle /
        topicTokens.length
      : 0;

  /*
     Title Focus answers a different question from coverage:
     "How much of this title is actually about the user's topic?"

     This is what separates a central/foundational paper from an
     application paper that merely contains every query term.
  */
  const titleFocus =
    titleTokens.length > 0
      ? Math.min(
          1,
          matchedInTitle /
          titleTokens.length,
        )
      : 0;

  const bodyCoverage =
    topicTokens.length > 0
      ? matchedInBody /
        topicTokens.length
      : 0;

  const topicCentrality =
    clamp01(
      (titleCoverage * 0.45) +
      (titleFocus * 0.40) +
      (bodyCoverage * 0.15),
    );

  const topicAdjustment =
    clampNumber(
      (
        topicCentrality -
        0.58
      ) * 18,
      -FINAL_TOPIC_ADJUSTMENT_LIMIT,
      FINAL_TOPIC_ADJUSTMENT_LIMIT,
    );

  /*
     Core-title bonus rewards papers whose title is centered on the
     complete topic, but only when it does not conflict with an
     explicit document-type request. This helps general/foundational
     papers beat narrow applications for broad scientific queries.
  */
  const titleSatisfiesRequestedType =
    titleMatchesRequestedDocumentType(
      title,
      intent.requestedDocumentType,
    );

  let coreTitleBonus = 0;

  if (
    titleCoverage >= 0.95 &&
    titleFocus >= 0.70 &&
    (
      !intent.requestedDocumentType ||
      titleSatisfiesRequestedType
    )
  ) {
    coreTitleBonus = 3;
  }
  else if (
    titleCoverage >= 0.95 &&
    titleFocus >= 0.50 &&
    (
      !intent.requestedDocumentType ||
      titleSatisfiesRequestedType
    )
  ) {
    coreTitleBonus = 1;
  }

  const conceptBalance =
    calculateFinalConceptBalance(
      item,
      topicTokens,
    );

  let conceptBalanceAdjustment =
    0;

  /*
     Only long topic queries are split into concept groups.
     This avoids over-interpreting compact queries such as
     "quantum error correction" while still understanding
     compound topics such as:
       renewable energy storage + lithium ion batteries
  */
  if (
    topicTokens.length >= 6
  ) {
    if (
      conceptBalance >= 0.80
    ) {
      conceptBalanceAdjustment = 4;
    }
    else if (
      conceptBalance >= 0.60
    ) {
      conceptBalanceAdjustment = 2;
    }
    else if (
      conceptBalance < 0.25
    ) {
      conceptBalanceAdjustment = -5;
    }
    else if (
      conceptBalance < 0.40
    ) {
      conceptBalanceAdjustment = -2;
    }
  }

  const documentConstraintAdjustment =
    clampNumber(
      calculateFinalDocumentConstraint(
        item,
        intent,
        topicCentrality,
      ),
      -FINAL_CONSTRAINT_ADJUSTMENT_LIMIT,
      FINAL_CONSTRAINT_ADJUSTMENT_LIMIT,
    );

  const accessConstraintAdjustment =
    intent.openAccessRequested
      ? (
          item?.isOpenAccess
            ? 1
            : -8
        )
      : 0;

  const integrityAdjustment =
    calculateRecordIntegrityAdjustment(
      item,
    );

  /*
     Citation count is intentionally only a tiny tie-breaker.
     BA relevance should not become "sort by popularity" and
     newer papers must still be able to rank first.
  */
  const citationTieBreak =
    Math.min(
      1.5,
      Math.log10(
        Number(
          item?.citedByCount ??
          item?.cited_by_count ??
          0,
        ) + 1,
      ) * 0.35,
    );

  return {
    titleCoverage,
    titleFocus,
    bodyCoverage,
    topicCentrality,
    conceptBalance,
    topicAdjustment,
    coreTitleBonus,
    conceptBalanceAdjustment,
    documentConstraintAdjustment,
    accessConstraintAdjustment,
    integrityAdjustment,
    citationTieBreak,
  };
}


function calculateFinalConceptBalance(
  item: any,
  topicTokens: string[],
) {
  if (
    topicTokens.length < 6
  ) {
    return 1;
  }

  const midpoint =
    Math.ceil(
      topicTokens.length / 2,
    );

  const groups =
    [
      topicTokens.slice(0, midpoint),
      topicTokens.slice(midpoint),
    ];

  const titleSet =
    new Set(
      tokenizeScientificText(
        String(item?.title ?? ""),
      ),
    );

  const abstractSet =
    new Set(
      tokenizeScientificText(
        String(item?.abstract ?? ""),
      ),
    );

  const groupCoverage =
    groups.map(
      (group) => {
        let matched = 0;

        for (const token of group) {
          if (
            titleSet.has(token)
          ) {
            matched += 1;
          }
          else if (
            abstractSet.has(token)
          ) {
            matched += 0.55;
          }
        }

        return matched /
          Math.max(
            1,
            group.length,
          );
      },
    );

  return Math.min(
    ...groupCoverage,
  );
}



function titleMatchesRequestedDocumentType(
  titleValue: string,
  requested: FinalQueryIntent["requestedDocumentType"],
) {
  if (!requested) {
    return true;
  }

  const title =
    normalizeScientificText(titleValue);

  if (
    requested === "systematic-review"
  ) {
    return /\bsystematic\s+review\b/.test(
      title,
    );
  }

  if (
    requested === "meta-analysis"
  ) {
    return /\bmeta\s+analysis\b/.test(
      title,
    );
  }

  if (
    requested === "review"
  ) {
    return /\breview\b/.test(title) ||
      /\bmeta\s+analysis\b/.test(title);
  }

  return true;
}


function calculateFinalDocumentConstraint(
  item: any,
  intent: FinalQueryIntent,
  topicCentrality: number,
) {
  const requested =
    intent.requestedDocumentType;

  if (!requested) {
    return 0;
  }

  const title =
    normalizeScientificText(
      String(item?.title ?? ""),
    )
      .replace(
        /\bpeer\s+review(?:ed)?\b/g,
        " ",
      );

  const searchable =
    normalizeScientificText(
      [
        item?.title,
        item?.abstract,
        item?.documentType,
        item?.document_type,
      ]
        .filter(Boolean)
        .join(" "),
    )
      .replace(
        /\bpeer\s+review(?:ed)?\b/g,
        " ",
      )
      .replace(
        /\breviewed\s+by\b/g,
        " ",
      );

  const type =
    String(
      item?.documentType ??
      item?.document_type ??
      "",
    )
      .trim()
      .toLowerCase();

  const strongTopicalSupport =
    topicCentrality >= 0.58;

  if (
    requested ===
      "systematic-review"
  ) {
    const exactTitle =
      /\bsystematic\s+review\b/.test(
        title,
      );

    const metaTitle =
      /\bmeta\s+analysis\b/.test(
        title,
      );

    const exactAnywhere =
      /\bsystematic\s+review\b/.test(
        searchable,
      ) ||
      type === "systematic-review";

    const ordinaryReviewTitle =
      /\breview\b/.test(title) &&
      !exactTitle;

    if (exactTitle) {
      return strongTopicalSupport
        ? 9
        : 2;
    }

    if (metaTitle) {
      return strongTopicalSupport
        ? 5
        : 1;
    }

    if (exactAnywhere) {
      return strongTopicalSupport
        ? 5
        : 1;
    }

    if (ordinaryReviewTitle) {
      return -6;
    }

    return -8;
  }

  if (
    requested ===
      "meta-analysis"
  ) {
    const exactTitle =
      /\bmeta\s+analysis\b/.test(
        title,
      );

    if (exactTitle) {
      return strongTopicalSupport
        ? 8
        : 2;
    }

    const exactAnywhere =
      /\bmeta\s+analysis\b/.test(
        searchable,
      ) ||
      type === "meta-analysis";

    return exactAnywhere
      ? 4
      : -6;
  }

  if (
    requested ===
      "review"
  ) {
    const reviewTitle =
      /\breview\b/.test(title) ||
      /\bmeta\s+analysis\b/.test(title);

    if (reviewTitle) {
      return strongTopicalSupport
        ? 3
        : 1;
    }

    const reviewAnywhere =
      /\breview\b/.test(searchable) ||
      type === "review" ||
      type === "systematic-review" ||
      type === "meta-analysis";

    return reviewAnywhere
      ? 1
      : -3;
  }

  if (
    requested ===
      "preprint"
  ) {
    return type === "preprint"
      ? 4
      : -4;
  }

  if (
    requested ===
      "article"
  ) {
    return type === "article"
      ? 2
      : -2;
  }

  return 0;
}


function calculateRecordIntegrityAdjustment(
  item: any,
) {
  const title =
    normalizeScientificText(
      String(item?.title ?? ""),
    );

  const doi =
    normalizeDoi(
      item?.doi,
    );

  /*
     Crossref sometimes exposes peer-review reports as separate
     records with titles such as:
       Review for "..."

     They are useful scholarly objects, but they are not the paper
     a researcher normally expects from a paper-search query.
  */
  const looksLikePeerReviewRecord =
    /^review\s+for\b/.test(title) ||
    /\/review\d+$/i.test(doi);

  if (looksLikePeerReviewRecord) {
    return FINAL_INTEGRITY_PENALTY;
  }

  return 0;
}


function calibrateDisplayScores(
  ranked: any[],
) {
  let previousScore =
    DISPLAY_SCORE_MAX + 1;

  let previousRaw =
    Number.POSITIVE_INFINITY;

  return ranked.map(
    (item: any, index: number) => {
      const raw =
        Number(
          item.finalRankingScore ??
          item.rawHybridScore ??
          item.hybridScore ??
          0,
        );

      /*
         Smooth logistic calibration:

         ~60 raw -> high 70s
         ~70 raw -> mid 80s
         ~80 raw -> low 90s
         ~90 raw -> mid 90s
         100+ raw -> high 90s

         This keeps excellent results excellent without turning
         every strong hit into 100/100.
      */
      const logistic =
        50 +
        (
          49 /
          (
            1 +
            Math.exp(
              -(
                raw - 55
              ) / 15,
            )
          )
        );

      let calibrated =
        Math.round(
          clampNumber(
            logistic,
            DISPLAY_SCORE_MIN,
            DISPLAY_SCORE_MAX,
          ),
        );

      /*
         Preserve visible ordering when two close raw scores would
         round to the same integer. We only separate them if the
         underlying ranking evidence is actually different.
      */
      if (
        index > 0 &&
        raw < previousRaw - 0.35 &&
        calibrated >= previousScore
      ) {
        calibrated =
          Math.max(
            DISPLAY_SCORE_MIN,
            previousScore - 1,
          );
      }

      previousRaw = raw;
      previousScore = calibrated;

      return {
        ...item,
        hybridScore: calibrated,
        baScore: calibrated,
        calibratedBaScore: calibrated,
      };
    },
  );
}


function getFinalTopicTokens(
  query: string,
) {
  const stopWords =
    new Set([
      "a",
      "an",
      "and",
      "are",
      "as",
      "at",
      "by",
      "for",
      "from",
      "in",
      "into",
      "of",
      "on",
      "or",
      "the",
      "to",
      "with",
      "using",
      "use",
      "uses",
      "via",
      "study",
      "studies",
      "method",
      "methods",
      "approach",
      "approaches",
      "model",
      "models",
      "system",
      "systems",
      "paper",
      "papers",
      "research",
      "analysis",
      "article",
      "articles",
      "review",
      "reviews",
      "systematic",
      "meta",
      "open",
      "access",
    ]);

  const seen =
    new Set<string>();

  const output: string[] = [];

  for (
    const token
    of tokenizeScientificText(query)
  ) {
    if (
      token.length < 2 ||
      stopWords.has(token) ||
      seen.has(token)
    ) {
      continue;
    }

    seen.add(token);
    output.push(token);
  }

  return output;
}


function getFinalMeaningfulTokens(
  value: string,
) {
  const boilerplate =
    new Set([
      "a",
      "an",
      "and",
      "are",
      "as",
      "at",
      "by",
      "for",
      "from",
      "in",
      "into",
      "of",
      "on",
      "or",
      "the",
      "to",
      "with",
      "using",
      "use",
      "uses",
      "via",
      "study",
      "studies",
      "method",
      "methods",
      "approach",
      "approaches",
      "model",
      "models",
      "system",
      "systems",
      "paper",
      "papers",
      "research",
      "analysis",
      "article",
      "articles",
      "review",
      "reviews",
      "systematic",
      "meta",
      "based",
      "new",
      "comprehensive",
      "role",
      "toward",
      "towards",
      "exploring",
      "unveiling",
    ]);

  return tokenizeScientificText(value)
    .filter(
      (token) =>
        token.length >= 2 &&
        !boilerplate.has(token),
    );
}


function tokenizeScientificText(
  value: string,
) {
  const normalized =
    normalizeScientificText(value);

  if (!normalized) {
    return [];
  }

  return normalized
    .split(/\s+/)
    .filter(Boolean);
}


function normalizeScientificText(
  value: string,
) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(
      /[\u0300-\u036f]/g,
      "",
    )
    .replace(
      /[^\p{L}\p{N}]+/gu,
      " ",
    )
    .trim()
    .replace(/\s+/g, " ");
}


function clamp01(
  value: number,
) {
  return Math.max(
    0,
    Math.min(
      1,
      value,
    ),
  );
}


function clampNumber(
  value: number,
  minimum: number,
  maximum: number,
) {
  return Math.max(
    minimum,
    Math.min(
      maximum,
      value,
    ),
  );
}


async function readJsonBody(
  request: Request,
) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

async function safeJson(
  response: Response,
) {
  try {
    return await response.json();
  } catch {
    return {
      error:
        await response.text(),
    };
  }
}

function jsonResponse(
  payload: unknown,
  status = 200,
) {
  return new Response(
    JSON.stringify(
      payload,
      null,
      2,
    ),
    {
      status,
      headers: {
        ...CORS_HEADERS,
        "Content-Type":
          "application/json; charset=utf-8",
        "Cache-Control":
          "no-store",
      },
    },
  );
}
