import "jsr:@supabase/functions-js@^2/edge-runtime.d.ts";


// BA Search v0.3.9 — Concept Group Coverage

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const PROVIDER_LIMIT = 30;
const RETURN_LIMIT = 60;

type ResearchResult = {
  key: string;
  openAlexId: string | null;
  doi: string | null;
  title: string;
  authors: string[];
  year: number | null;
  sourceName: string;
  documentType: string;
  citedByCount: number;
  isOpenAccess: boolean;
  url: string | null;
  abstract: string;
  sources: string[];
  retrievalScore: number;
  relevanceScore: number;
  queryCoverageScore: number;
  titleMatchScore: number;
  intentAnchorScore: number;
  requiredDomainAnchorScore: number;
  compoundTopicScore: number;
  intentMatchScore: number;
  explicitIntentScore: number;
  topicCentralityScore: number;
  coreTopicScore: number;
  sourceScore: number;
  citationScore: number;
  recencyScore: number;
  metadataScore: number;
  agreementScore: number;
  baScore: number;
};

// Provider response shapes used by the BA normalization layer.
// These describe accessed fields; they do not alter runtime payloads.
type OpenAlexWork = {
  id?: string | null;
  doi?: string | null;
  title?: string | null;
  display_name?: string | null;
  publication_year?: number | null;
  authorships?: Array<{
    author?: { display_name?: string };
  }> | null;
  primary_location?: {
    source?: { display_name?: string | null } | null;
    landing_page_url?: string | null;
    pdf_url?: string | null;
  } | null;
  open_access?: { is_oa?: boolean | null } | null;
  cited_by_count?: number | null;
  type?: string | null;
};

type CrossrefDate = {
  "date-parts"?: Array<Array<number | string | null>> | null;
};

type CrossrefWork = {
  DOI?: string | null;
  URL?: string | null;
  title?: string[] | null;
  author?: Array<{
    given?: string | null;
    family?: string | null;
  }> | null;
  "container-title"?: string[] | null;
  type?: string | null;
  "is-referenced-by-count"?: number | null;
  abstract?: string | null;
  published?: CrossrefDate | null;
  "published-print"?: CrossrefDate | null;
  "published-online"?: CrossrefDate | null;
  issued?: CrossrefDate | null;
  created?: CrossrefDate | null;
  license?: unknown[] | null;
  link?: Array<{ URL?: string | null }> | null;
};

type EuropePmcWork = {
  doi?: string | null;
  pmcid?: string | null;
  pmid?: string | null;
  title?: string | null;
  pubYear?: string | number | null;
  journalTitle?: string | null;
  journalInfo?: {
    journal?: { title?: string | null } | null;
  } | null;
  pubType?: string | null;
  pubTypeList?: { pubType?: string[] | null } | null;
  citedByCount?: number | null;
  isOpenAccess?: string | boolean | null;
  abstractText?: string | null;
  authorList?: {
    author?: Array<{
      fullName?: string | null;
      collectiveName?: string | null;
      firstName?: string | null;
      lastName?: string | null;
    }> | null;
  } | null;
  authorString?: string | null;
};

type DoajBib = {
  identifier?: Array<{ type?: string | null; id?: string | null }> | null;
  author?: Array<{ name?: string | null }> | null;
  journal?: { title?: string | null } | null;
  link?: Array<{ url?: string | null }> | null;
  abstract?: string | null;
  title?: string | null;
  year?: string | number | null;
  type?: string | null;
  document_type?: string | null;
};

type DoajRecord = {
  id?: string | null;
  bibjson?: DoajBib | null;
};

type VisitorCredential =
  | { kind: "guest" }
  | { kind: "user-token"; token: string }
  | { kind: "invalid" };

type ScientificDocumentType =
  | "none"
  | "article"
  | "review"
  | "systematic-review"
  | "meta-analysis"
  | "preprint"
  | "book-chapter";


type ScientificQueryAnalysis = {
  ok?: boolean;

  queryLanguage?: "ar" | "en" | "other";

  scientificQueries?: {
    ar?: {
      canonical?: string;
      variants?: string[];
    };

    en?: {
      canonical?: string;
      variants?: string[];
    };
  };

  coreConcepts?: Array<{
    en?: string;
    ar?: string;
    aliases?: string[];
  }>;

  protectedTerms?: string[];

  constraints?: {
    documentType?: ScientificDocumentType;
    openAccess?: boolean;
  };

  confidence?: number;
};

function classifyVisitorCredential(
  authorization: string | null,
  anonKey: string | null,
  legacyAnonKey: string | null,
): VisitorCredential {

  if (!authorization) {
    return { kind: "guest" };
  }

  const match = authorization.trim().match(
    /^Bearer\s+(\S+)$/i,
  );

  if (!match) {
    return { kind: "invalid" };
  }

  const token = match[1];

  // Recognize only explicitly configured public keys.
  // JWT contents alone must never establish identity.
  if (
    (anonKey && token === anonKey) ||
    (legacyAnonKey && token === legacyAnonKey)
  ) {
    return { kind: "guest" };
  }

  // Modern public project key, not a user session.
  if (token.startsWith("sb_publishable_")) {
    return { kind: "guest" };
  }

  // Secret API keys must never represent visitor identity.
  if (token.startsWith("sb_secret_")) {
    return { kind: "invalid" };
  }

  // A candidate user JWT still requires verification
  // through Supabase Auth.
  if (token.split(".").length !== 3) {
    return { kind: "invalid" };
  }

  return {
    kind: "user-token",
    token,
  };
}

Deno.serve(async (request) => {

  if (request.method === "OPTIONS") {
    return new Response(
      "ok",
      {
        headers: CORS_HEADERS,
      },
    );
  }

  if (request.method !== "POST") {
    return jsonResponse(
      {
        error: "Method not allowed",
      },
      405,
    );
  }

  try {

    const body =
      await request.json();

    const query =
      typeof body?.query === "string"
        ? body.query.trim()
        : "";

    if (
      !query ||
      query.length > 300
    ) {
      return jsonResponse(
        {
          error: "Invalid query",
        },
        400,
      );
    }

        // BA Search Rate Limiting
    // Reserve one search request before calling providers.

    const supabaseUrl =
      Deno.env.get("SUPABASE_URL");

    const serviceRoleKey =
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !serviceRoleKey) {
      console.error(
        "BA Search: missing rate-limit credentials",
      );

      return jsonResponse(
        {
          error: "Search temporarily unavailable.",
        },
        503,
      );
    }


    // Distinguish an internal Hybrid request from
    // a direct browser request.

    const incomingAuthorization =
      request.headers.get("authorization");

    const isInternalHybridRequest =
      incomingAuthorization === `Bearer ${serviceRoleKey}`;

    // Direct callers must never supply the internal
    // visitor-authorization forwarding header.
    if (
      !isInternalHybridRequest &&
      request.headers.has("x-ba-visitor-authorization")
    ) {
      return jsonResponse(
        { error: "Forbidden internal header." },
        403,
      );
    }

    // This is an unverified credential, NOT a user identity.
    // It will be validated through Supabase Auth next.
    const visitorAuthorization =
      isInternalHybridRequest
        ? request.headers.get("x-ba-visitor-authorization")
        : incomingAuthorization;


    // Classify the original visitor credential.
    // Classification does not establish user identity.


const visitorCredential =
  classifyVisitorCredential(
    visitorAuthorization,
    Deno.env.get("SUPABASE_ANON_KEY") ?? null,
    Deno.env.get("BA_LEGACY_ANON_KEY") ?? null,
  );



    // Reject malformed credentials instead of silently
    // treating them as guest requests.

    if (visitorCredential.kind === "invalid") {
      return jsonResponse(
        {
          error: "Invalid visitor credentials.",
        },
        401,
      );
    }


    // Verify user identity server-side.
    // Never extract user_id from an unverified JWT.

    let verifiedVisitorUserId: string | null = null;

    if (visitorCredential.kind === "user-token") {

      let authResponse: Response;

      try {
        authResponse = await fetch(
          `${supabaseUrl}/auth/v1/user`,
          {
            method: "GET",
            headers: {
              apikey: serviceRoleKey,
              Authorization:
                `Bearer ${visitorCredential.token}`,
            },
            signal: AbortSignal.timeout(4000),
          },
        );
      } catch {
        // An unavailable Auth service must not turn
        // a presented user token into a guest request.
        return jsonResponse(
          { error: "Authentication temporarily unavailable." },
          503,
        );
      }

      if (
        authResponse.status === 401 ||
        authResponse.status === 403
      ) {
        return jsonResponse(
          { error: "Invalid or expired user session." },
          401,
        );
      }

      if (!authResponse.ok) {
        return jsonResponse(
          { error: "Authentication temporarily unavailable." },
          503,
        );
      }

      let verifiedUser: { id?: unknown };

      try {
        verifiedUser = await authResponse.json();
      } catch {
        return jsonResponse(
          { error: "Invalid authentication response." },
          503,
        );
      }

      if (
        typeof verifiedUser?.id !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
          .test(verifiedUser.id)
      ) {
        return jsonResponse(
          { error: "Invalid authentication response." },
          503,
        );
      }

      verifiedVisitorUserId = verifiedUser.id;
    }

    let searchAllowed = false;

    try {

      const rateResponse = await fetch(
        `${supabaseUrl}/rest/v1/rpc/ba_reserve_search_request_v2`,
        {
          method: "POST",

          headers: {
            apikey: serviceRoleKey,
            Authorization: `Bearer ${serviceRoleKey}`,
            "Content-Type": "application/json",
          },

        body: JSON.stringify({
          p_user_id: verifiedVisitorUserId,
        }),

          signal: AbortSignal.timeout(4000),
        },
      );

      if (!rateResponse.ok) {
        throw new Error(
          `Search rate-limit RPC failed: ${rateResponse.status}`,
        );
      }

      searchAllowed =
        (await rateResponse.json()) === true;

    } catch (error) {

      console.error(
        "BA Search: rate-limit check failed",
        error instanceof Error ? error.message : "unknown",
      );

      return jsonResponse(
        {
          error: "Search temporarily unavailable.",
        },
        503,
      );

    }

    if (!searchAllowed) {

      return jsonResponse(
        {
          error:
            "Search limit reached. Please try again shortly.",

          code: "SEARCH_RATE_LIMITED",
        },
        429,
      );
    }

    const localIntent =
      parseResearchIntent(
        query,
      );


    const scientificAnalysis =
      await getScientificQueryAnalysis(
        query,
        supabaseUrl,
        serviceRoleKey,
      );


    const intent =
      applyScientificConstraints(
        localIntent,
        scientificAnalysis,
      );


    const scientificEnglishQuery =
      scientificAnalysis
        ?.scientificQueries
        ?.en
        ?.canonical
        ?.trim() ||
      "";


    const rankingQuery =
      scientificEnglishQuery ||
      query;


    const providerQuery =
      scientificEnglishQuery ||
      intent.providerQuery ||
      intent.topicQuery ||
      query;

    const providerTasks = [
      safeProvider(
        "OpenAlex",
        () =>
          searchOpenAlex(
            providerQuery,
          ),
      ),
      safeProvider(
        "Crossref",
        () =>
          searchCrossref(
            providerQuery,
          ),
      ),
      safeProvider(
        "Europe PMC",
        () =>
          searchEuropePmc(
            providerQuery,
          ),
      ),
      safeProvider(
        "arXiv",
        () =>
          searchArxiv(
            providerQuery,
          ),
      ),
      safeProvider(
        "DOAJ",
        () =>
          searchDoaj(
            providerQuery,
          ),
      ),
    ];

    const providerResponses =
      await Promise.all(
        providerTasks,
      );

    const successful =
      providerResponses.filter(
        (item) =>
          item.ok,
      );

    if (
      successful.length === 0
    ) {
      throw new Error(
        "All research providers failed.",
      );
    }

    const merged =
      mergeResults(
        successful.flatMap(
          (item) =>
            item.results,
        ),
      );

    const scored =
      scoreResults(
        merged,
        query,
        intent,
      )
        .sort(
          (a, b) =>
            b.baScore -
            a.baScore,
        )
        .slice(
          0,
          RETURN_LIMIT,
        );

    // Save newly discovered papers to BA memory
    const persistence = await persistBaPapersBestEffort(scored);

    return jsonResponse(
      {
        query,
        rankingQuery,
        intent,
        persistence,
        count:
          scored.length,
        sources:
          providerResponses.map(
            (provider) => ({
              name:
                provider.name,
              ok:
                provider.ok,
              count:
                provider.results.length,
            }),
          ),
        results:
          scored,
      },
      200,
    );

  }

  catch (error) {

    console.error(
      "BA research-search error:",
      error,
    );

    return jsonResponse(
      {
        error:
          "Unable to complete scientific search.",
      },
      500,
    );

  }

});


/* =========================================================
   PROVIDER SAFETY
========================================================= */

async function getScientificQueryAnalysis(
  query: string,
  supabaseUrl: string,
  serviceRoleKey: string,
): Promise<ScientificQueryAnalysis | null> {

  const internalSecret =
    Deno.env.get(
      "BA_SCIENTIFIC_QUERY_INTERNAL_SECRET",
    );


  if (!internalSecret) {
    return null;
  }


  try {

    const response =
      await fetch(
        `${supabaseUrl}/functions/v1/scientific-query`,
        {
          method: "POST",

          headers: {
            apikey: serviceRoleKey,

            Authorization:
              `Bearer ${serviceRoleKey}`,

            "Content-Type":
              "application/json",

            "x-ba-scientific-query-secret":
              internalSecret,
          },

          body:
            JSON.stringify({
              query,
            }),

          signal:
            AbortSignal.timeout(
              12_000,
            ),
        },
      );


    if (!response.ok) {
      return null;
    }


    const payload =
      await response.json() as
        ScientificQueryAnalysis;


    if (payload?.ok !== true) {
      return null;
    }


    return payload;

  }

  catch (error) {

    console.warn(
      "BA Search: Scientific Query unavailable; using local fallback.",
      error instanceof Error
        ? error.name
        : "Unknown error",
    );


    return null;

  }

}



async function safeProvider(
  name: string,
  task:
    () =>
      Promise<ResearchResult[]>,
) {

  try {

    const results =
      await task();

    return {
      name,
      ok: true,
      results,
    };

  }

  catch (error) {

    console.error(
      `${name} provider failed:`,
      error,
    );

    return {
      name,
      ok: false,
      results:
        [] as ResearchResult[],
    };

  }

}


/* =========================================================
   OPENALEX
========================================================= */

async function searchOpenAlex(
  query: string,
) {

  const url =
    new URL(
      "https://api.openalex.org/works",
    );

  url.searchParams.set(
    "search",
    query,
  );

  url.searchParams.set(
    "per-page",
    String(
      PROVIDER_LIMIT,
    ),
  );

  url.searchParams.set(
    "select",
    [
      "id",
      "doi",
      "title",
      "display_name",
      "publication_year",
      "authorships",
      "primary_location",
      "open_access",
      "cited_by_count",
      "type",
    ].join(","),
  );

  const response =
    await fetchJson(
      url.toString(),
      {
        Accept:
          "application/json",
      },
    );

  const rows =
    Array.isArray(
      response?.results,
    )
      ? response.results
      : [];

  return rows.map(
    (
      work: OpenAlexWork,
      index: number,
    ) => {
      const authors =
        Array.isArray(
          work.authorships,
        )
          ? work.authorships
            .map(
              (item: {
                author?: {
                  display_name?: string;
                };
              }) =>
                item
                  ?.author
                  ?.display_name,
            )
            .filter(
              (name): name is string =>
                Boolean(name),
            )
          : [];


      return createNormalizedResult(
        {
          key:
            work.doi ||
            work.id ||
            `openalex-${index}`,

          openAlexId:
            getOpenAlexId(
              work.id,
            ),

          doi:
            normalizeDoi(
              work.doi,
            ),

          title:
            work.display_name ||
            work.title ||
            "",

          authors,

          year:
            numberOrNull(
              work.publication_year,
            ),

          sourceName:
            work
              ?.primary_location
              ?.source
              ?.display_name ||
            "",

          documentType:
            normalizeDocumentType(
              work.type,
            ),

          citedByCount:
            numberOrZero(
              work.cited_by_count,
            ),

          isOpenAccess:
            Boolean(
              work
                ?.open_access
                ?.is_oa,
            ),

          url:
            safeUrl(
              work.doi,
            ) ||
            safeUrl(
              work
                ?.primary_location
                ?.landing_page_url,
            ) ||
            safeUrl(
              work
                ?.primary_location
                ?.pdf_url,
            ),

          abstract:
            "",

          sources:
            [
              "OpenAlex",
            ],

          retrievalScore:
            rankToScore(
              index,
              rows.length,
            ),
        },
      );

    },
  );

}


/* =========================================================
   CROSSREF
========================================================= */

async function searchCrossref(
  query: string,
) {

  const url =
    new URL(
      "https://api.crossref.org/works",
    );

  url.searchParams.set(
    "query.bibliographic",
    query,
  );

  url.searchParams.set(
    "rows",
    String(
      PROVIDER_LIMIT,
    ),
  );

  url.searchParams.set(
    "mailto",
    "contact@baquantum.org",
  );

  const response =
    await fetchJson(
      url.toString(),
      {
        Accept:
          "application/json",
        "User-Agent":
          "BA-Research/0.2 (mailto:contact@baquantum.org)",
      },
    );

  const rows =
    Array.isArray(
      response
        ?.message
        ?.items,
    )
      ? response.message.items
      : [];

  return rows.map(
    (
      work: CrossrefWork,
      index: number,
    ) => {

      const title =
        Array.isArray(
          work.title,
        )
          ? work.title[0] || ""
          : "";

      const authors =
        Array.isArray(
          work.author,
        )
          ? work.author
            .map(
              (author: NonNullable<CrossrefWork["author"]>[number]) =>
                [
                  author?.given,
                  author?.family,
                ]
                  .filter(Boolean)
                  .join(" "),
            )
            .filter(Boolean)
          : [];

      const sourceName =
        Array.isArray(
          work["container-title"],
        )
          ? work["container-title"][0] || ""
          : "";

      return createNormalizedResult(
        {
          key:
            work.DOI ||
            work.URL ||
            `crossref-${index}`,

          openAlexId:
            null,

          doi:
            normalizeDoi(
              work.DOI,
            ),

          title,

          authors,

          year:
            getCrossrefYear(
              work,
            ),

          sourceName,

          documentType:
            normalizeDocumentType(
              work.type,
            ),

          citedByCount:
            numberOrZero(
              work["is-referenced-by-count"],
            ),

          isOpenAccess:
            inferCrossrefOpenAccess(
              work,
            ),

          url:
            safeUrl(
              work.URL,
            ) ||
            (
              work.DOI
                ? safeUrl(
                  `https://doi.org/${work.DOI}`,
                )
                : null
            ),

          abstract:
            stripMarkup(
              work.abstract ||
              "",
            ),

          sources:
            [
              "Crossref",
            ],

          retrievalScore:
            rankToScore(
              index,
              rows.length,
            ),
        },
      );

    },
  );

}


/* =========================================================
   EUROPE PMC
========================================================= */

async function searchEuropePmc(
  query: string,
) {

  const url =
    new URL(
      "https://www.ebi.ac.uk/europepmc/webservices/rest/search",
    );

  url.searchParams.set(
    "query",
    query,
  );

  url.searchParams.set(
    "pageSize",
    String(
      PROVIDER_LIMIT,
    ),
  );

  url.searchParams.set(
    "format",
    "json",
  );

  url.searchParams.set(
    "resultType",
    "core",
  );

  const response =
    await fetchJson(
      url.toString(),
      {
        Accept:
          "application/json",
      },
    );

  const rows =
    Array.isArray(
      response
        ?.resultList
        ?.result,
    )
      ? response
        .resultList
        .result
      : [];

  return rows.map(
    (
      work: EuropePmcWork,
      index: number,
    ) => {

      const authors =
        parseEuropePmcAuthors(
          work,
        );

      const doi =
        normalizeDoi(
          work.doi,
        );

      const urlValue =
        doi
          ? `https://doi.org/${doi}`
          : (
              work.pmcid
                ? `https://europepmc.org/article/PMC/${encodeURIComponent(work.pmcid)}`
                : (
                    work.pmid
                      ? `https://europepmc.org/article/MED/${encodeURIComponent(work.pmid)}`
                      : null
                  )
            );

      return createNormalizedResult(
        {
          key:
            doi ||
            work.pmcid ||
            work.pmid ||
            `europepmc-${index}`,

          openAlexId:
            null,

          doi,

          title:
            work.title ||
            "",

          authors,

          year:
            numberOrNull(
              work.pubYear,
            ),

          sourceName:
            work.journalTitle ||
            work
              ?.journalInfo
              ?.journal
              ?.title ||
            "",

          documentType:
            inferEuropePmcDocumentType(
              work,
            ),

          citedByCount:
            numberOrZero(
              work.citedByCount,
            ),

          isOpenAccess:
            Boolean(
              work.isOpenAccess === "Y" ||
              work.isOpenAccess === true,
            ),

          url:
            safeUrl(
              urlValue,
            ),

          abstract:
            work.abstractText ||
            "",

          sources:
            [
              "Europe PMC",
            ],

          retrievalScore:
            rankToScore(
              index,
              rows.length,
            ),
        },
      );

    },
  );

}



/* =========================================================
   ARXIV
========================================================= */

async function searchArxiv(
  query: string,
) {

  const url =
    new URL(
      "https://export.arxiv.org/api/query",
    );

  url.searchParams.set(
    "search_query",
    `all:${query}`,
  );

  url.searchParams.set(
    "start",
    "0",
  );

  url.searchParams.set(
    "max_results",
    String(
      PROVIDER_LIMIT,
    ),
  );

  url.searchParams.set(
    "sortBy",
    "relevance",
  );

  url.searchParams.set(
    "sortOrder",
    "descending",
  );

  const xml =
    await fetchText(
      url.toString(),
      {
        Accept:
          "application/atom+xml",
        "User-Agent":
          "BA-Research/0.3",
      },
    );

  const entries =
    getXmlEntries(
      xml,
      "entry",
    );

  return entries.map(
    (
      entry,
      index,
    ) => {

      const title =
        decodeXmlEntities(
          getXmlTagText(
            entry,
            "title",
          ),
        )
          .replace(
            /\s+/g,
            " ",
          )
          .trim();

      const abstract =
        decodeXmlEntities(
          getXmlTagText(
            entry,
            "summary",
          ),
        )
          .replace(
            /\s+/g,
            " ",
          )
          .trim();

      const idUrl =
        decodeXmlEntities(
          getXmlTagText(
            entry,
            "id",
          ),
        )
          .trim();

      const published =
        getXmlTagText(
          entry,
          "published",
        );

      const year =
        published
          ? numberOrNull(
              published.slice(
                0,
                4,
              ),
            )
          : null;

      const authors =
        getXmlEntries(
          entry,
          "author",
        )
          .map(
            (authorBlock) =>
              decodeXmlEntities(
                getXmlTagText(
                  authorBlock,
                  "name",
                ),
              )
                .trim(),
          )
          .filter(Boolean);

      const doi =
        normalizeDoi(
          decodeXmlEntities(
            getXmlTagText(
              entry,
              "arxiv:doi",
            ),
          ),
        );

      return createNormalizedResult(
        {
          key:
            doi ||
            idUrl ||
            `arxiv-${index}`,

          openAlexId:
            null,

          doi,

          title,

          authors,

          year,

          sourceName:
            "arXiv",

          documentType:
            "preprint",

          citedByCount:
            0,

          isOpenAccess:
            true,

          url:
            safeUrl(
              idUrl,
            ),

          abstract,

          sources:
            [
              "arXiv",
            ],

          retrievalScore:
            rankToScore(
              index,
              entries.length,
            ),
        },
      );

    },
  );

}


/* =========================================================
   DOAJ
========================================================= */

async function searchDoaj(
  query: string,
) {

  const encodedQuery =
    encodeURIComponent(
      query,
    );

  const url =
    new URL(
      `https://doaj.org/api/search/articles/${encodedQuery}`,
    );

  url.searchParams.set(
    "page",
    "1",
  );

  url.searchParams.set(
    "pageSize",
    String(
      PROVIDER_LIMIT,
    ),
  );

  const response =
    await fetchJson(
      url.toString(),
      {
        Accept:
          "application/json",
        "User-Agent":
          "BA-Research/0.3",
      },
    );

  const rows =
    Array.isArray(
      response?.results,
    )
      ? response.results
      : [];

  return rows.map(
    (
      record: DoajRecord,
      index: number,
    ) => {

      const bib =
        record?.bibjson ||
        {};

      const identifiers =
        Array.isArray(
          bib.identifier,
        )
          ? bib.identifier
          : [];

      const doiIdentifier =
        identifiers.find(
          (item: NonNullable<DoajBib["identifier"]>[number]) =>
            String(
              item?.type ||
              "",
            )
              .toLowerCase() ===
            "doi",
        );

      const doi =
        normalizeDoi(
          doiIdentifier?.id,
        );

      const authors =
        Array.isArray(
          bib.author,
        )
          ? bib.author
            .map(
              (author: NonNullable<DoajBib["author"]>[number]) =>
                author?.name ||
                "",
            )
            .filter(Boolean)
          : [];

      const journalTitle =
        bib
          ?.journal
          ?.title ||
        "";

      const links =
        Array.isArray(
          bib.link,
        )
          ? bib.link
          : [];

      const fulltextLink =
        links.find(
          (item: NonNullable<DoajBib["link"]>[number]) =>
            typeof item?.url ===
              "string" &&
            item.url.startsWith(
              "http",
            ),
        );

      const doajRecordUrl =
        record?.id
          ? `https://doaj.org/article/${encodeURIComponent(record.id)}`
          : null;

      const abstract =
        typeof bib.abstract ===
          "string"
          ? bib.abstract
          : "";

      return createNormalizedResult(
        {
          key:
            doi ||
            record?.id ||
            `doaj-${index}`,

          openAlexId:
            null,

          doi,

          title:
            bib.title ||
            "",

          authors,

          year:
            numberOrNull(
              bib.year,
            ),

          sourceName:
            journalTitle,

          documentType:
            inferDoajDocumentType(
              bib,
            ),

          citedByCount:
            0,

          isOpenAccess:
            true,

          url:
            safeUrl(
              fulltextLink?.url,
            ) ||
            safeUrl(
              doajRecordUrl,
            ) ||
            (
              doi
                ? safeUrl(
                    `https://doi.org/${doi}`,
                  )
                : null
            ),

          abstract,

          sources:
            [
              "DOAJ",
            ],

          retrievalScore:
            rankToScore(
              index,
              rows.length,
            ),
        },
      );

    },
  );

}


/* =========================================================
   MERGE / DEDUPLICATION
========================================================= */

function mergeResults(
  input: ResearchResult[],
) {

  const merged:
    ResearchResult[] =
    [];

  const byDoi =
    new Map<
      string,
      ResearchResult
    >();

  const byTitle =
    new Map<
      string,
      ResearchResult
    >();

  for (
    const item
    of input
  ) {

    const doiKey =
      item.doi
        ? normalizeDoi(
            item.doi,
          )
        : null;

    const titleKey =
      titleFingerprint(
        item.title,
      );

    let existing:
      ResearchResult |
      undefined;

    if (doiKey) {
      existing =
        byDoi.get(
          doiKey,
        );
    }

    if (
      !existing &&
      titleKey
    ) {
      existing =
        byTitle.get(
          titleKey,
        );
    }

    if (!existing) {

      const clone =
        structuredClone(
          item,
        );

      merged.push(
        clone,
      );

      if (doiKey) {
        byDoi.set(
          doiKey,
          clone,
        );
      }

      if (titleKey) {
        byTitle.set(
          titleKey,
          clone,
        );
      }

      continue;
    }

    mergeInto(
      existing,
      item,
    );

    const mergedDoi =
      existing.doi
        ? normalizeDoi(
            existing.doi,
          )
        : null;

    const mergedTitle =
      titleFingerprint(
        existing.title,
      );

    if (doiKey) {
      byDoi.set(
        doiKey,
        existing,
      );
    }

    if (mergedDoi) {
      byDoi.set(
        mergedDoi,
        existing,
      );
    }

    if (titleKey) {
      byTitle.set(
        titleKey,
        existing,
      );
    }

    if (mergedTitle) {
      byTitle.set(
        mergedTitle,
        existing,
      );
    }

  }

  return merged;

}

function mergeInto(
  target: ResearchResult,
  incoming: ResearchResult,
) {

  target.sources =
    [
      ...new Set(
        [
          ...target.sources,
          ...incoming.sources,
        ],
      ),
    ];

  target.openAlexId =
    target.openAlexId ||
    incoming.openAlexId;

  target.doi =
    target.doi ||
    incoming.doi;

  target.title =
    chooseLonger(
      target.title,
      incoming.title,
    );

  target.authors =
    target.authors.length >=
      incoming.authors.length
      ? target.authors
      : incoming.authors;

  target.year =
    target.year ||
    incoming.year;

  target.sourceName =
    chooseLonger(
      target.sourceName,
      incoming.sourceName,
    );

  target.documentType =
    choosePreferredDocumentType(
      target.documentType,
      incoming.documentType,
    );

  target.citedByCount =
    Math.max(
      target.citedByCount,
      incoming.citedByCount,
    );

  target.isOpenAccess =
    target.isOpenAccess ||
    incoming.isOpenAccess;

  target.url =
    target.url ||
    incoming.url;

  target.abstract =
    chooseLonger(
      target.abstract,
      incoming.abstract,
    );

  target.retrievalScore =
    Math.max(
      target.retrievalScore,
      incoming.retrievalScore,
    );

}


/* =========================================================
   BA RANKING
========================================================= */

function scoreResults(
  results: ResearchResult[],
  query: string,
  intent: ResearchIntent,
) {

  const maxCitations =
    Math.max(
      1,
      ...results.map(
        (item) =>
          item.citedByCount,
      ),
    );

  const currentYear =
    new Date()
      .getUTCFullYear();

  for (
    const item
    of results
  ) {

    const searchableText =
      [
        item.title,
        item.abstract,
        item.sourceName,
        item.authors.join(" "),
      ]
        .filter(Boolean)
        .join(" ");

    const lexical =
      calculateLexicalRelevance(
        query,
        searchableText,
      );

    item.relevanceScore =
      clamp01(
        (
          item.retrievalScore *
          0.70
        ) +
        (
          lexical *
          0.30
        ),
      );

    item.queryCoverageScore =
      calculateQueryCoverage(
        query,
        searchableText,
      );

    item.titleMatchScore =
      calculateTitleMatch(
        query,
        item.title,
      );

    item.intentAnchorScore =
      calculateIntentAnchorScore(
        query,
        [
          item.title,
          item.abstract,
        ]
          .filter(Boolean)
          .join(" "),
      );

    item.requiredDomainAnchorScore =
      calculateRequiredDomainAnchorScore(
        intent.topicQuery ||
        query,
        item.title,
        item.abstract,
      );

    item.compoundTopicScore =
      calculateCompoundTopicScore(
        intent.topicQuery ||
        query,
        item.title,
        item.abstract,
      );

    item.intentMatchScore =
      calculateIntentMatchScore(
        item,
        intent,
      );

    item.explicitIntentScore =
      calculateExplicitIntentScore(
        item,
        intent,
      );

    item.topicCentralityScore =
      calculateTopicCentralityScore(
        intent.topicQuery ||
        query,
        item.title,
      );

    item.coreTopicScore =
      calculateCoreTopicScore(
        intent.topicQuery ||
        query,
        item.title,
        item.abstract,
      );

    item.sourceScore =
      calculateSourceScore(
        item,
        intent,
      );

    item.citationScore =
      Math.log1p(
        item.citedByCount,
      ) /
      Math.log1p(
        maxCitations,
      );

    const age =
      item.year
        ? Math.max(
          0,
          currentYear -
          item.year,
        )
        : 15;

    item.recencyScore =
      clamp01(
        1 -
        (
          age /
          15
        ),
      );

    item.metadataScore =
      calculateMetadataScore(
        item,
      );

    item.agreementScore =
      clamp01(
        (
          item.sources.length -
          1
        ) /
        4,
      );

    /*
       BA Search v0.3.6 — Benchmark Fix

       The 12-query benchmark showed three remaining weaknesses:
       1) generic-language leakage into technical queries,
       2) incomplete coverage of compound scientific topics,
       3) document-type intent not being strong enough.

       The weights below keep the existing ranking architecture,
       but reserve explicit space for the two new topic signals
       and strengthen explicit document-type intent.
    */

    item.baScore =
      Math.round(
        (
          item.relevanceScore *
          10
        ) +
        (
          item.queryCoverageScore *
          5
        ) +
        (
          item.titleMatchScore *
          12
        ) +
        (
          item.intentAnchorScore *
          9
        ) +
        (
          item.requiredDomainAnchorScore *
          10
        ) +
        (
          item.compoundTopicScore *
          11
        ) +
        (
          item.intentMatchScore *
          8
        ) +
        (
          item.explicitIntentScore *
          12
        ) +
        (
          item.topicCentralityScore *
          8
        ) +
        (
          item.coreTopicScore *
          7
        ) +
        (
          item.sourceScore *
          3
        ) +
        (
          item.citationScore *
          2
        ) +
        (
          item.recencyScore *
          1
        ) +
        (
          (
            item.isOpenAccess
              ? 1
              : 0
          ) *
          1
        ) +
        (
          item.metadataScore *
          0.5
        ) +
        (
          item.agreementScore *
          0.5
        ),
      );

          item.baScore =
  Math.max(
    0,
    Math.min(
      100,
      item.baScore +
      calculateConstraintAwareAdjustment(
        item,
        intent,
      ),
    ),
  );


  }

  return results;

}

/* =========================================================
   UTILITIES
========================================================= */

function createNormalizedResult(
  value:
    Partial<ResearchResult>,
): ResearchResult {

  return {
    key:
      String(
        value.key ||
        "",
      ),

    openAlexId:
      value.openAlexId ||
      null,

    doi:
      value.doi ||
      null,

    title:
      value.title ||
      "",

    authors:
      Array.isArray(
        value.authors,
      )
        ? value.authors
        : [],

    year:
      value.year ||
      null,

    sourceName:
      value.sourceName ||
      "",

    documentType:
      value.documentType ||
      "unknown",

    citedByCount:
      value.citedByCount ||
      0,

    isOpenAccess:
      Boolean(
        value.isOpenAccess,
      ),

    url:
      value.url ||
      null,

    abstract:
      value.abstract ||
      "",

    sources:
      Array.isArray(
        value.sources,
      )
        ? value.sources
        : [],

    retrievalScore:
      value.retrievalScore ||
      0,

    relevanceScore:
      0,

    queryCoverageScore:
      0,

    titleMatchScore:
      0,

    intentAnchorScore:
      0,

    requiredDomainAnchorScore:
      0,

    compoundTopicScore:
      0,

    intentMatchScore:
      0,

    explicitIntentScore:
      0,

    topicCentralityScore:
      0,

    coreTopicScore:
      0,

    sourceScore:
      0,

    citationScore:
      0,

    recencyScore:
      0,

    metadataScore:
      0,

    agreementScore:
      0,

    baScore:
      0,
  };

}

async function fetchJson(
  url: string,
  headers:
    Record<string, string>,
) {

  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () =>
        controller.abort(),
      10000,
    );

  try {

    const response =
      await fetch(
        url,
        {
          headers,
          signal:
            controller.signal,
        },
      );

    if (!response.ok) {

      throw new Error(
        `HTTP ${response.status}`,
      );

    }

    return await response.json();

  }

  finally {

    clearTimeout(
      timeout,
    );

  }

}


async function fetchText(
  url: string,
  headers:
    Record<string, string>,
) {

  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () =>
        controller.abort(),
      10000,
    );

  try {

    const response =
      await fetch(
        url,
        {
          headers,
          signal:
            controller.signal,
        },
      );

    if (!response.ok) {

      throw new Error(
        `HTTP ${response.status}`,
      );

    }

    return await response.text();

  }

  finally {

    clearTimeout(
      timeout,
    );

  }

}


function getXmlEntries(
  xml: string,
  tagName: string,
) {

  const escapedTag =
    tagName.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&",
    );

  const pattern =
    new RegExp(
      `<${escapedTag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escapedTag}>`,
      "gi",
    );

  const entries:
    string[] =
    [];

  let match:
    RegExpExecArray |
    null;

  while (
    (
      match =
        pattern.exec(
          xml,
        )
    ) !== null
  ) {

    entries.push(
      match[1] ||
      "",
    );

  }

  return entries;

}


function getXmlTagText(
  xml: string,
  tagName: string,
) {

  const escapedTag =
    tagName.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&",
    );

  const pattern =
    new RegExp(
      `<${escapedTag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escapedTag}>`,
      "i",
    );

  const match =
    xml.match(
      pattern,
    );

  return match?.[1] ||
    "";

}


function decodeXmlEntities(
  value: string,
) {

  return value
    .replace(
      /<!\[CDATA\[([\s\S]*?)\]\]>/g,
      "$1",
    )
    .replace(
      /&lt;/g,
      "<",
    )
    .replace(
      /&gt;/g,
      ">",
    )
    .replace(
      /&quot;/g,
      "\"",
    )
    .replace(
      /&apos;/g,
      "'",
    )
    .replace(
      /&amp;/g,
      "&",
    )
    .replace(
      /&#(\d+);/g,
      (
        _match,
        code,
      ) =>
        String.fromCodePoint(
          Number(code),
        ),
    )
    .replace(
      /&#x([0-9a-f]+);/gi,
      (
        _match,
        code,
      ) =>
        String.fromCodePoint(
          parseInt(
            code,
            16,
          ),
        ),
    );

}


function jsonResponse(
  value: unknown,
  status: number,
) {

  return new Response(
    JSON.stringify(
      value,
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

function normalizeDoi(
  value: unknown,
) {

  if (
    typeof value !== "string"
  ) {
    return null;
  }

  const normalized =
    value
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

  return normalized ||
    null;

}

function safeUrl(
  value: unknown,
) {

  if (
    typeof value !== "string" ||
    !value.trim()
  ) {
    return null;
  }

  let candidate =
    value.trim();

  const doi =
    normalizeDoi(
      candidate,
    );

  if (
    doi &&
    (
      candidate.startsWith("10.") ||
      candidate.includes("doi.org/")
    )
  ) {
    candidate =
      `https://doi.org/${doi}`;
  }

  try {

    const url =
      new URL(
        candidate,
      );

    if (
      url.protocol === "https:" ||
      url.protocol === "http:"
    ) {
      return url.href;
    }

  }

  catch {
    return null;
  }

  return null;

}

function getOpenAlexId(
  value: unknown,
) {

  if (
    typeof value !== "string"
  ) {
    return null;
  }

  const match =
    value.match(
      /W\d+$/i,
    );

  return match
    ? match[0]
    : null;

}

function numberOrZero(
  value: unknown,
) {

  const number =
    Number(
      value,
    );

  return Number.isFinite(
    number,
  )
    ? number
    : 0;

}

function numberOrNull(
  value: unknown,
) {

  const number =
    Number(
      value,
    );

  return Number.isFinite(
    number,
  ) &&
    number > 0
    ? number
    : null;

}

function rankToScore(
  index: number,
  count: number,
) {

  if (
    count <= 1
  ) {
    return 1;
  }

  return clamp01(
    1 -
    (
      index /
      (
        count -
        1
      )
    ),
  );

}

function calculateLexicalRelevance(
  query: string,
  text: string,
) {

  const queryTokens =
    tokenize(
      query,
    );

  if (
    queryTokens.length === 0
  ) {
    return 0;
  }

  const haystack =
    new Set(
      tokenize(
        text,
      ),
    );

  const matches =
    queryTokens.filter(
      (token) =>
        haystack.has(
          token,
        ),
    ).length;

  return matches /
    queryTokens.length;

}

function calculateQueryCoverage(
  query: string,
  text: string,
) {

  const queryTokens =
    tokenize(
      query,
    );

  if (
    queryTokens.length === 0
  ) {
    return 0;
  }

  const textTokens =
    new Set(
      tokenize(
        text,
      ),
    );

  let matchedWeight =
    0;

  let totalWeight =
    0;

  for (
    const token
    of queryTokens
  ) {

    const weight =
      getQueryTermWeight(
        token,
      );

    totalWeight +=
      weight;

    if (
      textTokens.has(
        token,
      )
    ) {

      matchedWeight +=
        weight;

    }

  }

  if (
    totalWeight === 0
  ) {
    return 0;
  }

  return clamp01(
    matchedWeight /
    totalWeight,
  );

}


function getQueryTermWeight(
  token: string,
) {

  if (
    token.includes("-") ||
    /\d/.test(token)
  ) {
    return 1.7;
  }

  if (
    token.length >= 8
  ) {
    return 1.5;
  }

  return 1;

}




type ResearchIntent = {
  originalQuery: string;
  topicQuery: string;
  providerQuery: string;
  openAccessOnly: boolean;
  requestedDocumentType:
    "review" |
    "systematic-review" |
    "meta-analysis" |
    "preprint" |
    "article" |
    null;
};


function applyScientificConstraints(
  localIntent: ResearchIntent,
  scientificAnalysis: ScientificQueryAnalysis | null,
): ResearchIntent {

  const scientificDocumentType =
    scientificAnalysis
      ?.constraints
      ?.documentType;


  const supportedDocumentType:
    ResearchIntent["requestedDocumentType"] =
      scientificDocumentType === "article" ||
      scientificDocumentType === "review" ||
      scientificDocumentType === "systematic-review" ||
      scientificDocumentType === "meta-analysis" ||
      scientificDocumentType === "preprint"
        ? scientificDocumentType
        : null;


  return {
    ...localIntent,

    openAccessOnly:
      localIntent.openAccessOnly ||
      scientificAnalysis
        ?.constraints
        ?.openAccess === true,

    requestedDocumentType:
      localIntent.requestedDocumentType ||
      supportedDocumentType,
  };

}



function parseResearchIntent(
  query: string,
): ResearchIntent {

  let topicQuery =
    query
      .trim();

  let providerQuery =
    topicQuery;

  let openAccessOnly =
    false;

  let requestedDocumentType:
    ResearchIntent[
      "requestedDocumentType"
    ] =
    null;

  if (
    /\bopen[\s-]+access\b/i.test(
      topicQuery,
    )
  ) {

    openAccessOnly =
      true;

    topicQuery =
      topicQuery.replace(
        /\bopen[\s-]+access\b/gi,
        " ",
      );

    providerQuery =
      providerQuery.replace(
        /\bopen[\s-]+access\b/gi,
        " ",
      );

  }

  if (
    /\bsystematic[\s-]+review\b/i.test(
      topicQuery,
    )
  ) {

    requestedDocumentType =
      "systematic-review";

    topicQuery =
      topicQuery.replace(
        /\bsystematic[\s-]+review\b/gi,
        " ",
      );

  }

  else if (
    /\bmeta[\s-]*analysis\b/i.test(
      topicQuery,
    )
  ) {

    requestedDocumentType =
      "meta-analysis";

    topicQuery =
      topicQuery.replace(
        /\bmeta[\s-]*analysis\b/gi,
        " ",
      );

  }

  else if (
    /\breview\b/i.test(
      topicQuery,
    )
  ) {

    requestedDocumentType =
      "review";

    topicQuery =
      topicQuery.replace(
        /\breview\b/gi,
        " ",
      );

  }

  else if (
    /\bpreprint\b/i.test(
      topicQuery,
    )
  ) {

    requestedDocumentType =
      "preprint";

    topicQuery =
      topicQuery.replace(
        /\bpreprint\b/gi,
        " ",
      );

  }

  else if (
    /\b(article|journal article)\b/i.test(
      topicQuery,
    )
  ) {

    requestedDocumentType =
      "article";

    topicQuery =
      topicQuery.replace(
        /\b(journal article|article)\b/gi,
        " ",
      );

  }

  topicQuery =
    topicQuery
      .replace(
        /\s+/g,
        " ",
      )
      .trim();

  providerQuery =
    providerQuery
      .replace(
        /\s+/g,
        " ",
      )
      .trim();

  return {
    originalQuery:
      query,

    topicQuery,

    providerQuery,

    openAccessOnly,

    requestedDocumentType,
  };

}


function calculateIntentMatchScore(
  item: ResearchResult,
  intent: ResearchIntent,
) {

  let score =
    1;

  if (
    intent.openAccessOnly
  ) {

    score *=
      item.isOpenAccess
        ? 1
        : 0.15;

  }

  if (
    intent.requestedDocumentType
  ) {

    score *=
      documentTypeMatchScore(
        item.documentType,
        intent.requestedDocumentType,
      );

  }

  return clamp01(
    score,
  );

}


function documentTypeMatchScore(
  actual: string,
  requested:
    ResearchIntent[
      "requestedDocumentType"
    ],
) {

  if (!requested) {
    return 1;
  }

  const normalized =
    normalizeDocumentType(
      actual,
    );

  if (
    requested ===
      "systematic-review"
  ) {

    if (
      normalized ===
        "systematic-review"
    ) {
      return 1;
    }

    if (
      normalized ===
        "meta-analysis"
    ) {
      return 0.80;
    }

    if (
      normalized ===
        "review"
    ) {
      return 0.55;
    }

    return 0.15;

  }

  if (
    requested ===
      "meta-analysis"
  ) {

    if (
      normalized ===
        "meta-analysis"
    ) {
      return 1;
    }

    if (
      normalized ===
        "systematic-review" ||
      normalized ===
        "review"
    ) {
      return 0.7;
    }

    return 0.2;

  }

  if (
    requested ===
      "review"
  ) {

    if (
      normalized ===
        "review" ||
      normalized ===
        "systematic-review" ||
      normalized ===
        "meta-analysis"
    ) {
      return 1;
    }

    return 0.25;

  }

  if (
    requested ===
      "preprint"
  ) {

    return normalized ===
      "preprint"
        ? 1
        : 0.2;

  }

  if (
    requested ===
      "article"
  ) {

    if (
      normalized ===
        "article"
    ) {
      return 1;
    }

    if (
      normalized ===
        "preprint"
    ) {
      return 0.65;
    }

    return 0.25;

  }

  return 1;

}



function calculateExplicitIntentScore(
  item: ResearchResult,
  intent: ResearchIntent,
) {

  const searchable =
    normalizeSearchText(
      [
        item.title,
        item.abstract,
        item.documentType,
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

  let score =
    1;

  if (
    intent.openAccessOnly &&
    !item.isOpenAccess
  ) {
    score *=
      0.1;
  }

  const requested =
    intent.requestedDocumentType;

  if (!requested) {
    return clamp01(
      score,
    );
  }

  const type =
    normalizeDocumentType(
      item.documentType,
    );

  if (
    requested ===
      "review"
  ) {

    const explicitReviewSignal =
      /\breview\b/.test(
        searchable,
      ) ||
      type ===
        "review" ||
      type ===
        "systematic-review" ||
      type ===
        "meta-analysis";

    score *=
      explicitReviewSignal
        ? 1
        : 0.2;

  }

  else if (
    requested ===
      "systematic-review"
  ) {

    const explicitSystematicSignal =
      /\bsystematic\s+review\b/.test(
        searchable,
      ) ||
      type ===
        "systematic-review";

    score *=
      explicitSystematicSignal
        ? 1
        : 0.08;

  }

  else if (
    requested ===
      "meta-analysis"
  ) {

    const explicitMetaSignal =
      /\bmeta\s*analysis\b/.test(
        searchable,
      ) ||
      type ===
        "meta-analysis";

    score *=
      explicitMetaSignal
        ? 1
        : 0.15;

  }

  else if (
    requested ===
      "preprint"
  ) {

    score *=
      type ===
        "preprint"
        ? 1
        : 0.2;

  }

  else if (
    requested ===
      "article"
  ) {

    score *=
      (
        type ===
          "article" ||
        type ===
          "review" ||
        type ===
          "systematic-review" ||
        type ===
          "meta-analysis"
      )
        ? 1
        : 0.25;

  }

  return clamp01(
    score,
  );

}




/* =========================================================
   BA SEARCH v0.3.6 — BENCHMARK FIX SIGNALS
========================================================= */

function getDomainMeaningfulTokens(
  query: string,
) {

  const generic =
    new Set(
      [
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
        "method",
        "methods",
        "approach",
        "approaches",
        "protect",
        "protecting",
        "protection",
        "study",
        "studies",
        "paper",
        "papers",
        "research",
        "analysis",
        "model",
        "models",
        "system",
        "systems",
      ],
    );

  return tokenize(
    normalizeSearchText(
      query,
    ),
  ).filter(
    (token) =>
      !generic.has(
        token,
      ),
  );

}


function calculateRequiredDomainAnchorScore(
  query: string,
  title: string,
  abstract: string,
) {

  const queryTokens =
    getDomainMeaningfulTokens(
      query,
    );

  if (
    queryTokens.length === 0
  ) {
    return 1;
  }


  const titleSet =
    new Set(
      tokenize(
        normalizeSearchText(
          title,
        ),
      ),
    );


  const abstractSet =
    new Set(
      tokenize(
        normalizeSearchText(
          abstract || "",
        ),
      ),
    );


  let matchedWeighted = 0;
  let totalWeighted = 0;
  let matchedCount = 0;


  for (
    const token
    of queryTokens
  ) {

    const weight =
      Math.max(
        1,
        getIntentAnchorWeight(
          token,
        ),
      );


    totalWeighted +=
      weight;


    const inTitle =
      titleSet.has(
        token,
      );


    const inAbstract =
      abstractSet.has(
        token,
      );


    if (
      inTitle ||
      inAbstract
    ) {

      matchedCount += 1;


      matchedWeighted +=
        weight *
        (
          inTitle
            ? 1
            : 0.68
        );

    }

  }


  let coverage =
    totalWeighted > 0
      ? matchedWeighted /
        totalWeighted
      : 0;


  const rawCoverage =
    matchedCount /
    Math.max(
      1,
      queryTokens.length,
    );


  /*
     Multi-concept queries should not rank highly
     when a paper only matches a small subset
     of the scientific topic.
  */

  if (
    queryTokens.length >= 4 &&
    rawCoverage < 0.5
  ) {

    coverage *= 0.45;

  }

  else if (
    queryTokens.length >= 4 &&
    rawCoverage < 0.67
  ) {

    coverage *= 0.72;

  }


  return clamp01(
    coverage,
  );

}


function calculateCompoundTopicScore(
  query: string,
  title: string,
  abstract: string,
) {

  const queryTokens =
    getDomainMeaningfulTokens(
      query,
    );

  if (
    queryTokens.length < 2
  ) {
    return 1;
  }

  const normalizedTitle =
    ` ${normalizeSearchText(
      title,
    )} `;

  const normalizedAbstract =
    ` ${normalizeSearchText(
      abstract || "",
    )} `;

  const coveredIndexes =
    new Set<number>();

  /*
     Build 2- and 3-token topic phrases directly from the query.
     We score coverage of query concepts that participate in a
     matched phrase rather than simply counting matched phrases.

     Example:
       renewable energy storage lithium ion batteries

     "Lithium-Ion Batteries" covers only part of the query,
     while a title containing both "renewable energy storage"
     and "lithium ion batteries" covers nearly all of it.
  */
  for (
    const phraseLength
    of [3, 2]
  ) {

    for (
      let index = 0;
      index <=
        queryTokens.length -
        phraseLength;
      index += 1
    ) {

      const phraseTokens =
        queryTokens.slice(
          index,
          index +
          phraseLength,
        );

      const phrase =
        phraseTokens.join(
          " ",
        );

      const paddedPhrase =
        ` ${phrase} `;

      const titleMatch =
        normalizedTitle.includes(
          paddedPhrase,
        );

      const abstractMatch =
        normalizedAbstract.includes(
          paddedPhrase,
        );

      if (
        titleMatch ||
        abstractMatch
      ) {

        for (
          let offset = 0;
          offset < phraseLength;
          offset += 1
        ) {

          /*
             Abstract-only phrase support counts, but title
             support remains the stronger signal.
          */
          if (
            titleMatch ||
            phraseLength === 3
          ) {
            coveredIndexes.add(
              index +
              offset,
            );
          }

        }

      }

    }

  }

  const phraseCoverage =
    coveredIndexes.size /
    Math.max(
      1,
      queryTokens.length,
    );

  /*
     Also keep a light single-term coverage component so a
     legitimate topic with no exact phrase formatting does not
     collapse to zero.
  */
  const combinedTextSet =
    new Set(
      tokenize(
        normalizeSearchText(
          [
            title,
            abstract,
          ]
            .filter(Boolean)
            .join(" "),
        ),
      ),
    );

  const singleMatches =
    queryTokens.filter(
      (token) =>
        combinedTextSet.has(
          token,
        ),
    ).length;

  const singleCoverage =
    singleMatches /
    Math.max(
      1,
      queryTokens.length,
    );

  return clamp01(
    (
      phraseCoverage *
      0.72
    ) +
    (
      singleCoverage *
      0.28
    ),
  );

}

function calculateDocumentTypeEnforcementAdjustment(
  item: ResearchResult,
  intent: ResearchIntent,
) {

  const requested =
    intent.requestedDocumentType;

  if (!requested) {
    return 0;
  }


  /*
     v0.3.8:
     نثق بعنوان الورقة أولًا عند وجود طلب صريح
     مثل "systematic review"، لأن metadata القادمة
     من المصادر قد تكون عامة أو غير دقيقة.
  */

  const title =
    normalizeSearchText(
      item.title || "",
    )
      .replace(
        /\bpeer\s+review(?:ed)?\b/g,
        " ",
      );


  const searchable =
    normalizeSearchText(
      [
        item.title,
        item.abstract,
        item.documentType,
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
    normalizeDocumentType(
      item.documentType,
    );


  if (
    requested ===
      "systematic-review"
  ) {

    const exactInTitle =
      /\bsystematic\s+review\b/.test(
        title,
      );


    const exactAnywhere =
      /\bsystematic\s+review\b/.test(
        searchable,
      ) ||
      type ===
        "systematic-review";


    const ordinaryReviewInTitle =
      /\breview\b/.test(
        title,
      ) &&
      !exactInTitle;


    const metaInTitle =
      /\bmeta\s*analysis\b/.test(
        title,
      );


    if (exactInTitle) {
      return 10;
    }


    if (metaInTitle) {
      return 5;
    }


    if (exactAnywhere) {
      return 6;
    }


    if (ordinaryReviewInTitle) {
      return -7;
    }


    return -9;

  }


  if (
    requested ===
      "meta-analysis"
  ) {

    const exactInTitle =
      /\bmeta\s*analysis\b/.test(
        title,
      );


    if (exactInTitle) {
      return 9;
    }


    const exactAnywhere =
      /\bmeta\s*analysis\b/.test(
        searchable,
      ) ||
      type ===
        "meta-analysis";


    return exactAnywhere
      ? 5
      : -7;

  }


  if (
    requested ===
      "review"
  ) {

    const reviewInTitle =
      /\breview\b/.test(
        title,
      ) ||
      /\bmeta\s*analysis\b/.test(
        title,
      );


    if (reviewInTitle) {
      return 4;
    }


    const reviewLike =
      /\breview\b/.test(
        searchable,
      ) ||
      type ===
        "review" ||
      type ===
        "systematic-review" ||
      type ===
        "meta-analysis";


    return reviewLike
      ? 2
      : -4;

  }


  if (
    requested ===
      "preprint"
  ) {

    return type ===
      "preprint"
        ? 5
        : -5;

  }


  if (
    requested ===
      "article"
  ) {

    return type ===
      "article"
        ? 3
        : -2;

  }


  return 0;

}


function calculateTopicBreadthAdjustment(
  item: ResearchResult,
  intent: ResearchIntent,
) {

  const queryTokens =
    getDomainMeaningfulTokens(
      intent.topicQuery ||
      intent.originalQuery,
    );


  /*
     الاستعلامات القصيرة غالبًا تمثل مفهومًا واحدًا.
     نستخدم Topic Breadth فقط عندما يحتوي السؤال
     على عدة مفاهيم علمية.
  */

  if (
    queryTokens.length < 4
  ) {
    return 0;
  }


  const titleTokens =
    new Set(
      tokenize(
        normalizeSearchText(
          item.title || "",
        ),
      ),
    );


  const combinedTokens =
    new Set(
      tokenize(
        normalizeSearchText(
          [
            item.title,
            item.abstract,
          ]
            .filter(Boolean)
            .join(" "),
        ),
      ),
    );


  const titleMatches =
    queryTokens.filter(
      (token) =>
        titleTokens.has(
          token,
        ),
    ).length;


  const combinedMatches =
    queryTokens.filter(
      (token) =>
        combinedTokens.has(
          token,
        ),
    ).length;


  const titleCoverage =
    titleMatches /
    queryTokens.length;


  const combinedCoverage =
    combinedMatches /
    queryTokens.length;


  /*
     Soft Gate وليس حذفًا.

     الورقة التي يغطي عنوانها معظم الاستعلام المركب
     تحصل على boost.

     الورقة التي تغطي جزءًا صغيرًا فقط تنخفض،
     لكنها لا تختفي من النتائج.
  */

  if (
    titleCoverage >= 0.84
  ) {
    return 9;
  }


  if (
    titleCoverage >= 0.67
  ) {
    return 6;
  }


  if (
    titleCoverage >= 0.50
  ) {
    return 2;
  }


  if (
    combinedCoverage >= 0.67
  ) {
    return 1;
  }


  if (
    combinedCoverage < 0.50
  ) {
    return -7;
  }


  return -3;

}

function calculateConceptGroupCoverageAdjustment(
  item: ResearchResult,
  intent: ResearchIntent,
) {

  const tokens =
    getDomainMeaningfulTokens(
      intent.topicQuery ||
      intent.originalQuery,
    );


  /*
     نطبق Concept Group Coverage فقط على
     الاستعلامات التي تحتوي عدة مفاهيم فعلًا.
  */

  if (
    tokens.length < 5
  ) {
    return 0;
  }


  /*
     نقسم الموضوع إلى مجموعتين متوازنتين
     بدون أي hardcode لمجال علمي معين.

     مثال:

     renewable energy storage lithium ion batteries

     يصبح تقريبًا:

     Group A:
     renewable energy storage

     Group B:
     lithium ion batteries
  */

  const midpoint =
    Math.ceil(
      tokens.length / 2,
    );


  const groups =
    [
      tokens.slice(
        0,
        midpoint,
      ),

      tokens.slice(
        midpoint,
      ),
    ]
      .filter(
        (group) =>
          group.length > 0
      );


  const titleTokens =
    new Set(
      tokenize(
        normalizeSearchText(
          item.title || "",
        ),
      ),
    );


  const abstractTokens =
    new Set(
      tokenize(
        normalizeSearchText(
          item.abstract || "",
        ),
      ),
    );


  const groupScores =
    groups.map(
      (group) => {

        let score = 0;


        for (
          const token
          of group
        ) {

          if (
            titleTokens.has(
              token,
            )
          ) {

            score += 1;

          }

          else if (
            abstractTokens.has(
              token,
            )
          ) {

            score += 0.65;

          }

        }


        return score /
          Math.max(
            1,
            group.length,
          );

      },
    );


  const minimumGroupCoverage =
    Math.min(
      ...groupScores,
    );


  const averageGroupCoverage =
    groupScores.reduce(
      (sum, value) =>
        sum + value,
      0,
    ) /
    groupScores.length;


  /*
     المهم هنا هو أضعف مجموعة.

     إذا الورقة تطابق مجموعة واحدة فقط بقوة،
     لكن المجموعة الثانية شبه غائبة،
     فلا نريد أن تبقى في الأعلى.
  */

  if (
    minimumGroupCoverage >= 0.80
  ) {
    return 10;
  }


  if (
    minimumGroupCoverage >= 0.60
  ) {
    return 7;
  }


  if (
    minimumGroupCoverage >= 0.40
  ) {
    return 3;
  }


  if (
    minimumGroupCoverage < 0.20 &&
    averageGroupCoverage >= 0.45
  ) {
    return -8;
  }


  if (
    minimumGroupCoverage < 0.35
  ) {
    return -5;
  }


  return 0;

}

function calculateConstraintAwareAdjustment(
  item: ResearchResult,
  intent: ResearchIntent,
) {

  const documentAdjustment =
    calculateDocumentTypeEnforcementAdjustment(
      item,
      intent,
    );


  const breadthAdjustment =
    calculateTopicBreadthAdjustment(
      item,
      intent,
    );


  const conceptGroupAdjustment =
    calculateConceptGroupCoverageAdjustment(
      item,
      intent,
    );


  /*
     BA Ranking يبقى الأساس.

     هذه الطبقة فقط تحسم الحالات المتقاربة
     وتخفض النتائج التي تطابق جانبًا واحدًا
     من استعلام متعدد المفاهيم.
  */

  return Math.max(
    -16,
    Math.min(
      16,
      documentAdjustment +
      breadthAdjustment +
      conceptGroupAdjustment,
    ),
  );

}


function calculateTopicCentralityScore(
  query: string,
  title: string,
) {

  const queryTokens =
    tokenize(
      normalizeSearchText(
        query,
      ),
    );

  const titleTokens =
    tokenize(
      normalizeSearchText(
        title,
      ),
    );

  if (
    queryTokens.length === 0 ||
    titleTokens.length === 0
  ) {
    return 0;
  }

  const ignored =
    new Set(
      [
        "a",
        "an",
        "and",
        "as",
        "at",
        "based",
        "by",
        "for",
        "from",
        "in",
        "into",
        "of",
        "on",
        "the",
        "to",
        "using",
        "with",
        "study",
        "analysis",
        "approach",
        "method",
        "methods",
        "model",
        "models",
      ],
    );

  const meaningfulTitleTokens =
    titleTokens.filter(
      (token) =>
        !ignored.has(
          token,
        ),
    );

  if (
    meaningfulTitleTokens.length === 0
  ) {
    return 0;
  }

  const querySet =
    new Set(
      queryTokens,
    );

  let matchedWeight =
    0;

  let titleWeight =
    0;

  for (
    const token
    of meaningfulTitleTokens
  ) {

    const weight =
      getQueryTermWeight(
        token,
      );

    titleWeight +=
      weight;

    if (
      querySet.has(
        token,
      )
    ) {
      matchedWeight +=
        weight;
    }

  }

  const titleFocus =
    titleWeight > 0
      ? matchedWeight /
        titleWeight
      : 0;

  const queryCoverage =
    calculateQueryCoverage(
      query,
      title,
    );

  /*
     A result should score highly when the user's concepts
     are central to the title, not merely present inside a
     long application-specific title.
  */
  return clamp01(
    (
      queryCoverage *
      0.55
    ) +
    (
      titleFocus *
      0.45
    ),
  );

}



function calculateCoreTopicScore(
  query: string,
  title: string,
  abstract: string,
) {

  const normalizedQuery =
    normalizeSearchText(
      query,
    );

  const normalizedTitle =
    normalizeSearchText(
      title,
    );

  const queryTokens =
    tokenize(
      normalizedQuery,
    );

  const titleTokens =
    tokenize(
      normalizedTitle,
    );

  if (
    queryTokens.length === 0 ||
    titleTokens.length === 0
  ) {
    return 0;
  }

  const genericWords =
    new Set(
      [
        "a",
        "an",
        "and",
        "as",
        "at",
        "by",
        "for",
        "from",
        "in",
        "into",
        "of",
        "on",
        "the",
        "to",
        "using",
        "via",
        "with",
        "study",
        "analysis",
        "approach",
        "method",
        "methods",
        "model",
        "models",
        "framework",
        "toward",
        "towards",
      ],
    );

  const meaningfulQuery =
    queryTokens.filter(
      (token) =>
        !genericWords.has(
          token,
        ),
    );

  const meaningfulTitle =
    titleTokens.filter(
      (token) =>
        !genericWords.has(
          token,
        ),
    );

  if (
    meaningfulQuery.length === 0 ||
    meaningfulTitle.length === 0
  ) {
    return 0;
  }

  const querySet =
    new Set(
      meaningfulQuery,
    );

  const matchedTitleTerms =
    meaningfulTitle.filter(
      (token) =>
        querySet.has(
          token,
        ),
    );

  const uniqueMatched =
    new Set(
      matchedTitleTerms,
    );

  const coverage =
    clamp01(
      uniqueMatched.size /
      Math.max(
        1,
        new Set(
          meaningfulQuery,
        ).size,
      ),
    );

  /*
     "Purity" measures how much of the title is actually
     about the user's topic rather than a narrow downstream
     application. A foundational/core-topic paper tends to
     have fewer unrelated title concepts.
  */
  const purity =
    clamp01(
      matchedTitleTerms.length /
      Math.max(
        1,
        meaningfulTitle.length,
      ),
    );

  /*
     Application-like title grammar is a weak signal only.
     It never blocks a result; it merely reduces the core-topic
     score when the title says the queried technique is being
     used "for", "on", or "to predict/classify/detect" something.
  */
  const applicationPattern =
    /\b(using|based on|for|applied to|application of|prediction|predicting|classification|classifying|detection|detecting|forecasting|optimization)\b/i;

  const looksApplicationSpecific =
    applicationPattern.test(
      title,
    );

  /*
     Abstract support prevents short generic titles from being
     over-rewarded when the paper is not actually centered on
     the query topic.
  */
  const abstractCoverage =
    abstract
      ? calculateQueryCoverage(
          query,
          abstract,
        )
      : coverage;

  let score =
    (
      coverage *
      0.45
    ) +
    (
      purity *
      0.35
    ) +
    (
      abstractCoverage *
      0.20
    );

  if (
    looksApplicationSpecific &&
    purity < 0.55
  ) {
    score *=
      0.78;
  }

  return clamp01(
    score,
  );

}


function calculateSourceScore(
  item: ResearchResult,
  intent: ResearchIntent,
) {

  const sources =
    new Set(
      item.sources ||
      [],
    );

  let best =
    0.55;

  if (
    sources.has(
      "OpenAlex",
    )
  ) {
    best =
      Math.max(
        best,
        0.92,
      );
  }

  if (
    sources.has(
      "Crossref",
    )
  ) {

    best =
      Math.max(
        best,
        item.documentType ===
          "book-chapter"
          ? 0.45
          : 0.78,
      );

  }

  if (
    sources.has(
      "Europe PMC",
    )
  ) {

    best =
      Math.max(
        best,
        0.95,
      );

  }

  if (
    sources.has(
      "arXiv",
    )
  ) {

    best =
      Math.max(
        best,
        intent.requestedDocumentType ===
          "review"
          ? 0.62
          : 0.9,
      );

  }

  if (
    sources.has(
      "DOAJ",
    )
  ) {

    best =
      Math.max(
        best,
        intent.openAccessOnly
          ? 0.96
          : 0.84,
      );

  }

  if (
    item.documentType ===
      "book-chapter"
  ) {

    best *=
      0.7;

  }

  return clamp01(
    best,
  );

}


function normalizeDocumentType(
  value: unknown,
) {

  if (
    typeof value !== "string" ||
    !value.trim()
  ) {
    return "unknown";
  }

  const normalized =
    value
      .toLowerCase()
      .replace(
        /_/g,
        "-",
      )
      .trim();

  if (
    normalized.includes(
      "systematic",
    ) &&
    normalized.includes(
      "review",
    )
  ) {
    return "systematic-review";
  }

  if (
    normalized.includes(
      "meta",
    ) &&
    normalized.includes(
      "analysis",
    )
  ) {
    return "meta-analysis";
  }

  if (
    normalized.includes(
      "review",
    )
  ) {
    return "review";
  }

  if (
    normalized.includes(
      "book-chapter",
    ) ||
    normalized.includes(
      "book chapter",
    ) ||
    normalized ===
      "book-chapter"
  ) {
    return "book-chapter";
  }

  if (
    normalized.includes(
      "preprint",
    ) ||
    normalized.includes(
      "posted-content",
    )
  ) {
    return "preprint";
  }

  if (
    normalized.includes(
      "journal-article",
    ) ||
    normalized ===
      "article" ||
    normalized ===
      "research-article"
  ) {
    return "article";
  }

  return normalized;

}


function inferEuropePmcDocumentType(
  work: EuropePmcWork,
) {

  const publicationTypes =
    [
      work?.pubType,
      ...(Array.isArray(
        work?.pubTypeList?.pubType
      )
        ? work.pubTypeList.pubType
        : []),
    ]
      .filter(Boolean)
      .join(" ");

  return normalizeDocumentType(
    publicationTypes ||
    "article",
  );

}


function inferDoajDocumentType(
  bib: DoajBib,
) {

  const type =
    bib?.type ||
    bib?.document_type ||
    "article";

  return normalizeDocumentType(
    type,
  );

}


function choosePreferredDocumentType(
  first: string,
  second: string,
) {

  const priority:
    Record<string, number> =
    {
      "systematic-review": 6,
      "meta-analysis": 6,
      "review": 5,
      "article": 4,
      "preprint": 3,
      "book-chapter": 2,
      "unknown": 1,
    };

  const normalizedFirst =
    normalizeDocumentType(
      first,
    );

  const normalizedSecond =
    normalizeDocumentType(
      second,
    );

  return (
    priority[
      normalizedSecond
    ] ||
    1
  ) >
    (
      priority[
        normalizedFirst
      ] ||
      1
    )
    ? normalizedSecond
    : normalizedFirst;

}


function calculateIntentAnchorScore(
  query: string,
  text: string,
) {

  const normalizedQuery =
    normalizeSearchText(
      query,
    );

  const normalizedText =
    normalizeSearchText(
      text,
    );

  const queryTokens =
    tokenize(
      normalizedQuery,
    );

  const textTokenSet =
    new Set(
      tokenize(
        normalizedText,
      ),
    );

  if (
    queryTokens.length === 0
  ) {
    return 0;
  }

  const anchors =
    selectIntentAnchors(
      queryTokens,
    );

  if (
    anchors.length === 0
  ) {
    return 1;
  }

  let matchedWeight =
    0;

  let totalWeight =
    0;

  for (
    const anchor
    of anchors
  ) {

    totalWeight +=
      anchor.weight;

    if (
      textTokenSet.has(
        anchor.token,
      )
    ) {
      matchedWeight +=
        anchor.weight;
    }

  }

  const coverage =
    totalWeight > 0
      ? matchedWeight /
        totalWeight
      : 0;

  /*
     Strong penalty when the query contains two or more
     specific technical anchors and the paper misses most
     of them. This prevents broad-but-popular papers from
     outranking papers that match the user's precise intent.
  */

  const matchedCount =
    anchors.filter(
      (anchor) =>
        textTokenSet.has(
          anchor.token,
        ),
    ).length;

  if (
    anchors.length >= 2 &&
    matchedCount === 0
  ) {
    return 0;
  }

  if (
    anchors.length >= 2 &&
    matchedCount === 1
  ) {
    return clamp01(
      coverage *
      0.65,
    );
  }

  return clamp01(
    coverage,
  );

}


function selectIntentAnchors(
  queryTokens: string[],
) {

  const genericTerms =
    new Set(
      [
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

        "method",
        "methods",
        "approach",
        "approaches",
        "using",
        "use",
        "uses",
        "protect",
        "protecting",
        "protection",
        "study",
        "studies",
        "paper",
        "papers",
        "research",
        "analysis",
        "model",
        "models",
        "system",
        "systems",

        "disease",
        "diagnosis",
        "diagnostic",
        "biomarker",
        "biomarkers",
        "blood",
        "alzheimer",
        "alzheimer's",
        "quantum",
        "error",
        "correction",
      ],
    );

  /*
     Intent anchors must represent the scientific/domain concepts
     in the query, not generic request language such as
     "methods", "protecting", "study", or "using".

     Example:
       methods for protecting qubits from noise
     anchors should become:
       qubits, noise
     rather than:
       protecting, methods, qubits
  */

  const candidates =
    queryTokens
      .map(
        (token) => ({
          token,
          weight:
            getIntentAnchorWeight(
              token,
            ),
        }),
      )
      .filter(
        (item) =>
          !genericTerms.has(
            item.token,
          ) &&
          item.weight > 1,
      )
      .sort(
        (a, b) =>
          b.weight -
          a.weight,
      );

  /*
     Keep only the strongest three concepts.
     For:
       blood biomarkers Alzheimer plasma p-tau
     this should prioritize:
       ptau, plasma

     For:
       surface code quantum error correction
     this should prioritize:
       surface, code
  */

  return candidates.slice(
    0,
    3,
  );

}


function getIntentAnchorWeight(
  token: string,
) {

  if (
    token === "ptau"
  ) {
    return 3;
  }

  if (
    /\d/.test(
      token,
    )
  ) {
    return 2.8;
  }

  if (
    token.length >= 10
  ) {
    return 2.4;
  }

  if (
    token.length >= 7
  ) {
    return 2;
  }

  if (
    token.length >= 5
  ) {
    return 1.5;
  }

  return 1;

}


function calculateTitleMatch(
  query: string,
  title: string,
) {

  if (
    typeof title !== "string" ||
    !title.trim()
  ) {
    return 0;
  }

  const normalizedQuery =
    normalizeSearchText(
      query,
    );

  const normalizedTitle =
    normalizeSearchText(
      title,
    );

  const queryTokens =
    tokenize(
      normalizedQuery,
    );

  const titleTokens =
    tokenize(
      normalizedTitle,
    );

  if (
    queryTokens.length === 0 ||
    titleTokens.length === 0
  ) {
    return 0;
  }

  const titleTokenSet =
    new Set(
      titleTokens,
    );

  let matchedWeight =
    0;

  let totalQueryWeight =
    0;

  for (
    const token
    of queryTokens
  ) {

    const weight =
      getTitleQueryTermWeight(
        token,
      );

    totalQueryWeight +=
      weight;

    if (
      titleTokenSet.has(
        token,
      )
    ) {
      matchedWeight +=
        weight;
    }

  }

  const coverage =
    totalQueryWeight > 0
      ? matchedWeight /
        totalQueryWeight
      : 0;

  /*
     Focus rewards titles where the matched query concepts
     make up a meaningful share of the title itself.

     This helps prevent a long, narrow paper from ranking
     above a paper whose title is centered on the user's
     actual search intent.
  */

  const matchedUniqueTokens =
    new Set(
      queryTokens.filter(
        (token) =>
          titleTokenSet.has(
            token,
          ),
      ),
    );

  const focus =
    clamp01(
      (
        matchedUniqueTokens.size /
        Math.max(
          1,
          titleTokenSet.size,
        )
      ) *
      2.4,
    );

  /*
     Phrase boost rewards consecutive concepts in the same
     order. Technical expressions such as:

     plasma p-tau
     surface code
     quantum error correction

     therefore receive extra weight when they are central
     to the paper title.
  */

  const phraseBoost =
    calculateTitlePhraseBoost(
      queryTokens,
      titleTokens,
    );

  return clamp01(
    (
      coverage *
      0.55
    ) +
    (
      focus *
      0.20
    ) +
    (
      phraseBoost *
      0.25
    ),
  );

}


function calculateTitlePhraseBoost(
  queryTokens: string[],
  titleTokens: string[],
) {

  if (
    queryTokens.length < 2 ||
    titleTokens.length < 2
  ) {
    return 0;
  }

  const titleText =
    ` ${titleTokens.join(" ")} `;

  let matchedWeight =
    0;

  let totalWeight =
    0;

  for (
    let index = 0;
    index <
      queryTokens.length - 1;
    index += 1
  ) {

    const first =
      queryTokens[index];

    const second =
      queryTokens[index + 1];

    const phrase =
      ` ${first} ${second} `;

    const weight =
      (
        getTitleQueryTermWeight(
          first,
        ) +
        getTitleQueryTermWeight(
          second,
        )
      ) /
      2;

    totalWeight +=
      weight;

    if (
      titleText.includes(
        phrase,
      )
    ) {
      matchedWeight +=
        weight;
    }

  }

  if (
    totalWeight === 0
  ) {
    return 0;
  }

  return clamp01(
    matchedWeight /
    totalWeight,
  );

}


function getTitleQueryTermWeight(
  token: string,
) {

  /*
     Longer, numeric and compact technical terms carry
     more intent than short generic terms.
  */

  if (
    /\d/.test(
      token,
    )
  ) {
    return 2.2;
  }

  if (
    token === "ptau" ||
    token.length >= 10
  ) {
    return 2;
  }

  if (
    token.length >= 7
  ) {
    return 1.6;
  }

  if (
    token.length >= 5
  ) {
    return 1.25;
  }

  return 1;

}


function normalizeSearchText(
  value: string,
) {

  return value
    .toLowerCase()
    .normalize("NFKC")

    /*
       Normalize common written forms of phosphorylated tau
       so that:
       p-tau
       p tau
       phosphorylated tau
       are treated as the same technical concept.
    */

    .replace(
      /\bphosphorylated[\s-]+tau\b/g,
      " ptau ",
    )
    .replace(
      /\bp[\s-]*tau\b/g,
      " ptau ",
    )

    /*
       Normalize Alzheimer's / Alzheimer disease wording.
    */

    .replace(
      /\balzheimer['’]?s\b/g,
      " alzheimer ",
    )

    .replace(
      /\s+/g,
      " ",
    )
    .trim();

}


function tokenize(
  value: string,
) {

  return value
    .toLowerCase()
    .normalize("NFKC")
    .replace(
      /[^\p{L}\p{N}\s]/gu,
      " ",
    )
    .split(/\s+/)
    .map(
      (token) =>
        token.trim(),
    )
    .filter(
      (token) =>
        token.length > 2,
    );

}

function calculateMetadataScore(
  item: ResearchResult,
) {

  const values =
    [
      item.title,
      item.year,
      item.sourceName,
      item.doi,
      item.url,
      item.authors.length > 0,
    ];

  return (
    values.filter(Boolean)
      .length /
    values.length
  );

}

function titleFingerprint(
  value: string,
) {

  return value
    .toLowerCase()
    .normalize("NFKC")
    .replace(
      /[^\p{L}\p{N}]/gu,
      "",
    )
    .slice(
      0,
      220,
    );

}

function chooseLonger(
  first: string,
  second: string,
) {

  return (
    second?.length || 0
  ) >
    (
      first?.length || 0
    )
    ? second
    : first;

}

function stripMarkup(
  value: unknown,
) {

  if (
    typeof value !== "string"
  ) {
    return "";
  }

  return value
    .replace(
      /<[^>]+>/g,
      " ",
    )
    .replace(
      /\s+/g,
      " ",
    )
    .trim();

}

function getCrossrefYear(
  work: CrossrefWork,
) {

  const dateCandidates =
    [
      work?.published,
      work?.["published-print"],
      work?.["published-online"],
      work?.issued,
      work?.created,
    ];

  for (
    const candidate
    of dateCandidates
  ) {

    const year =
      candidate
        ?.["date-parts"]
        ?.[0]
        ?.[0];

    if (
      Number.isFinite(
        Number(year),
      )
    ) {
      return Number(year);
    }

  }

  return null;

}

function inferCrossrefOpenAccess(
  work: CrossrefWork,
) {

  if (
    Array.isArray(
      work?.license,
    ) &&
    work.license.length > 0
  ) {
    return true;
  }

  if (
    Array.isArray(
      work?.link,
    ) &&
    work.link.some(
      (item: NonNullable<CrossrefWork["link"]>[number]) =>
        typeof item?.URL === "string" &&
        item.URL.startsWith("http"),
    )
  ) {
    return true;
  }

  return false;

}

function parseEuropePmcAuthors(
  work: EuropePmcWork,
) {

  const authorList =
    work
      ?.authorList
      ?.author;

  if (
    Array.isArray(
      authorList,
    )
  ) {

    const names =
      authorList
        .map(
          (author: NonNullable<NonNullable<EuropePmcWork["authorList"]>["author"]>[number]) =>
            author.fullName ||
            author
              .collectiveName ||
            [
              author.firstName,
              author.lastName,
            ]
              .filter(Boolean)
              .join(" "),
        )
        .filter(Boolean);

    if (
      names.length > 0
    ) {
      return names;
    }

  }

  if (
    typeof work.authorString ===
      "string"
  ) {
    return work.authorString
      .split(",")
      .map(
        (name: string) =>
          name.trim(),
      )
      .filter(Boolean);
  }

  return [];

}

function clamp01(
  value: number,
) {

  return Math.min(
    1,
    Math.max(
      0,
      Number(value) || 0,
    ),
  );

}


/* =========================================================
   BA PAPER MEMORY — Best-Effort Persistence

   Saves newly discovered papers without overwriting
   existing records or their embeddings.
========================================================= */

async function persistBaPapersBestEffort(
  papers: ResearchResult[],
) {

  const attempted = Math.min(
    papers.length,
    24,
  );

  if (attempted === 0) {
    return {
      ok: true,
      attempted: 0,
    };
  }

  try {

    const supabaseUrl =
      Deno.env.get("SUPABASE_URL");

    const serviceRoleKey =
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !serviceRoleKey) {

      console.warn(
        "BA Paper Memory: missing server credentials",
      );

      return {
        ok: false,
        attempted,
        reason: "missing-credentials",
      };

    }

    const rows = papers
      .slice(0, 24)
      .map((item) => {

        const title =
          String(item.title || "")
            .trim();

        if (!title) {
          return null;
        }

        const doi =
          normalizeDoi(item.doi);

        const fallbackTitle =
          titleFingerprint(title);

        const canonicalKey =
          doi
            ? `doi:${doi}`
            : fallbackTitle
              ? `title:${fallbackTitle}`
              : null;

        if (!canonicalKey) {
          return null;
        }

        const abstract =
          String(item.abstract || "")
            .trim();

        return {

          canonical_key: canonicalKey,

          doi,

          openalex_id:
            item.openAlexId,

          title,

          abstract,

          authors:
            item.authors,

          publication_year:
            item.year,

          journal_name:
            item.sourceName || null,

          document_type:
            item.documentType || "unknown",

          is_open_access:
            Boolean(item.isOpenAccess),

          cited_by_count:
            Number(item.citedByCount || 0),

          source_url:
            item.url,

          sources:
            item.sources,

          embedding_content:
            [title, abstract]
              .filter(Boolean)
              .join("\n\n")
              .slice(0, 5000),

          updated_at:
            new Date().toISOString(),

        };

      })
      .filter((row) => row !== null);

    if (rows.length === 0) {

      return {
        ok: true,
        attempted: 0,
      };

    }

        // Reserve the global BA memory write budget first.
    // If the budget is unavailable, skip persistence safely.
    let budgetResponse: Response;

    try {

      budgetResponse = await fetch(
        `${supabaseUrl}/rest/v1/rpc/ba_reserve_memory_write`,
        {
          method: "POST",

          headers: {
            apikey: serviceRoleKey,
            Authorization: `Bearer ${serviceRoleKey}`,
            "Content-Type": "application/json",
          },

          body: JSON.stringify({
            p_paper_count: rows.length,
          }),

          signal: AbortSignal.timeout(2500),
        },
      );

    } catch (error) {

      console.warn(
        "BA Paper Memory: budget check unavailable",
        error instanceof Error ? error.name : "unknown",
      );

      return {
        ok: false,
        attempted: 0,
        reason: "write-budget-unavailable",
      };

    }

    if (!budgetResponse.ok) {

      console.warn(
        `BA Paper Memory: budget RPC failed (${budgetResponse.status})`,
      );

      return {
        ok: false,
        attempted: 0,
        reason: "write-budget-check-failed",
      };

    }

    const writeAllowed = await budgetResponse.json();

    if (writeAllowed !== true) {

      return {
        ok: false,
        attempted: 0,
        reason: "write-budget-exhausted",
      };

    }

    const controller =
      new AbortController();

    const timeout =
      setTimeout(
        () => controller.abort(),
        3500,
      );

    try {

      const response = await fetch(
        `${supabaseUrl}/rest/v1/ba_papers?on_conflict=canonical_key`,
        {
          method: "POST",

          headers: {

            apikey:
              serviceRoleKey,

            Authorization:
              `Bearer ${serviceRoleKey}`,

            "Content-Type":
              "application/json",

            Prefer:
              "resolution=ignore-duplicates,return=minimal",

          },

          body:
            JSON.stringify(rows),

          signal:
            controller.signal,

        },
      );

      if (!response.ok) {

        console.warn(
          `BA Paper Memory: insert failed (${response.status})`,
        );

        return {
          ok: false,
          attempted: rows.length,
          reason: "database-write-failed",
        };

      }

      return {
        ok: true,
        attempted: rows.length,
      };

    }

    finally {

      clearTimeout(timeout);

    }

  }

  catch (error) {

    console.warn(
      "BA Paper Memory: unavailable",
      error instanceof Error
        ? error.message
        : "unknown",
    );

    return {
      ok: false,
      attempted,
      reason: "best-effort-fallback",
    };

  }

}