import json
import os
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "supabase/functions/research-search/index.ts"
MARKER = "Deno.serve(async (request) => {"


def check(condition, message):
    if not condition:
        raise AssertionError(message)


def main():
    source = SOURCE.read_text(encoding="utf-8")

    if source.count(MARKER) != 1:
        raise RuntimeError("Unexpected research-search entrypoint.")

    calls = {
        "rate_limit": 0,
        "scientific_query": 0,
        "openalex": 0,
        "crossref": 0,
        "europepmc": 0,
        "arxiv": 0,
        "doaj": 0,
    }

    seen_provider_queries = []

    class MockServer(BaseHTTPRequestHandler):
        def _send_json(self, status, payload):
            data = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self):
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length)

            if self.path == "/rest/v1/rpc/ba_reserve_search_request_v2":
                calls["rate_limit"] += 1
                return self._send_json(200, True)

            if self.path == "/functions/v1/scientific-query":
                calls["scientific_query"] += 1

                check(
                    self.headers.get("x-ba-scientific-query-secret")
                    == "LOCAL_SCIENTIFIC_TEST_SECRET",
                    "Scientific Query internal secret missing or incorrect.",
                )

                payload = json.loads(body.decode("utf-8"))

                check(
                    payload.get("query")
                    == "ما هي أحدث الأبحاث عن التشابك الكمومي في الحواسيب الكمومية؟",
                    "Scientific Query did not receive original Arabic query.",
                )

                return self._send_json(
                    200,
                    {
                        "ok": True,
                        "version": "v0.5.0-test",
                        "engine": "BA Scientific Query Intelligence Test",
                        "queryLanguage": "ar",
                        "originalQuery": payload["query"],
                        "scientificQueries": {
                            "ar": {
                                "canonical":
                                    "التشابك الكمومي في الحوسبة الكمومية",
                                "variants": [],
                            },
                            "en": {
                                "canonical":
                                    "quantum entanglement in quantum computing",
                                "variants": [],
                            },
                        },
                        "coreConcepts": [],
                        "protectedTerms": [],
                        "constraints": {
                            "documentType": "systematic-review",
                            "openAccess": True,
                        },
                        "confidence": 0.99,
                    },
                )

            return self._send_json(
                404,
                {"ok": False, "error": "Unexpected POST endpoint"},
            )

        def do_GET(self):
            parsed = urllib.parse.urlparse(self.path)
            query_params = urllib.parse.parse_qs(parsed.query)

            # OpenAlex
            if parsed.path == "/works":
                calls["openalex"] += 1
                seen_provider_queries.append(
                    query_params.get("search", [""])[0]
                )

                return self._send_json(
                    200,
                    {
                        "results": [
                            {
                                "id": "https://openalex.org/WTEST1",
                                "doi": "https://doi.org/10.1234/test",
                                "title":
                                    "Quantum entanglement in quantum computing",
                                "publication_year": 2025,
                                "cited_by_count": 10,
                                "open_access": {
                                    "is_oa": True,
                                },
                                "authorships": [],
                                "primary_location": {
                                    "source": {
                                        "display_name": "Test Journal"
                                    }
                                },
                            }
                        ]
                    },
                )

            # Crossref
            if parsed.path == "/works-crossref":
                calls["crossref"] += 1
                seen_provider_queries.append(
                    query_params.get("query.bibliographic", [""])[0]
                )

                return self._send_json(
                    200,
                    {
                        "message": {
                            "items": [
                                {
                                    "DOI": "10.1234/test",
                                    "title": [
                                        "Quantum entanglement in quantum computing"
                                    ],
                                    "author": [],
                                    "type": "journal-article",
                                    "is-referenced-by-count": 10,
                                }
                            ]
                        }
                    },
                )

            # Europe PMC
            if parsed.path == "/europepmc":
                calls["europepmc"] += 1
                seen_provider_queries.append(
                    query_params.get("query", [""])[0]
                )

                return self._send_json(
                    200,
                    {
                        "resultList": {
                            "result": []
                        }
                    },
                )

            # arXiv
            if parsed.path == "/arxiv":
                calls["arxiv"] += 1
                seen_provider_queries.append(
                    query_params.get("search_query", [""])[0]
                )

                xml = """<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"></feed>"""

                data = xml.encode("utf-8")
                self.send_response(200)
                self.send_header(
                    "Content-Type",
                    "application/atom+xml",
                )
                self.send_header(
                    "Content-Length",
                    str(len(data)),
                )
                self.end_headers()
                self.wfile.write(data)
                return

            # DOAJ
            if parsed.path.startswith("/doaj/"):
                calls["doaj"] += 1

                decoded = urllib.parse.unquote(
                    parsed.path.removeprefix("/doaj/")
                )
                seen_provider_queries.append(decoded)

                return self._send_json(
                    200,
                    {
                        "results": []
                    },
                )

            return self._send_json(
                404,
                {"ok": False, "error": "Unexpected GET endpoint"},
            )

        def log_message(self, *args):
            pass

    mock = ThreadingHTTPServer(
        ("127.0.0.1", 0),
        MockServer,
    )

    thread = threading.Thread(
        target=mock.serve_forever,
        daemon=True,
    )
    thread.start()

    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]

    modified = source.replace(
        MARKER,
        (
            'Deno.serve({ hostname: "127.0.0.1", port: '
            + str(port)
            + ' }, async (request) => {'
        ),
        1,
    )

    mock_base = f"http://127.0.0.1:{mock.server_port}"

    # Redirect provider URLs to local mocks.
    modified = modified.replace(
        "https://api.openalex.org/works",
        f"{mock_base}/works",
    )

    modified = modified.replace(
        "https://api.crossref.org/works",
        f"{mock_base}/works-crossref",
    )

    modified = modified.replace(
        "https://www.ebi.ac.uk/europepmc/webservices/rest/search",
        f"{mock_base}/europepmc",
    )

    modified = modified.replace(
        "https://export.arxiv.org/api/query",
        f"{mock_base}/arxiv",
    )

    modified = modified.replace(
        "https://doaj.org/api/search/articles/",
        f"{mock_base}/doaj/",
    )

    process = None

    try:
        with tempfile.TemporaryDirectory(
            prefix="ba-research-scientific-test-"
        ) as folder:

            test_file = Path(folder) / "index.ts"
            test_file.write_text(
                modified,
                encoding="utf-8",
            )

            env = {
                "PATH": os.environ.get("PATH", ""),
                "HOME": os.environ.get("HOME", ""),
                "SUPABASE_URL": mock_base,
                "SUPABASE_SERVICE_ROLE_KEY":
                    "LOCAL_TEST_SERVICE_ROLE",
                "BA_SCIENTIFIC_QUERY_INTERNAL_SECRET":
                    "LOCAL_SCIENTIFIC_TEST_SECRET",
            }

            process = subprocess.Popen(
                [
                    "deno",
                    "run",
                    "--allow-net=127.0.0.1",
                    "--allow-env",
                    str(test_file),
                ],
                env=env,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )

            endpoint = f"http://127.0.0.1:{port}"

            ready = False

            for _ in range(50):
                if process.poll() is not None:
                    break

                try:
                    req = urllib.request.Request(
                        endpoint,
                        method="OPTIONS",
                    )

                    with urllib.request.urlopen(
                        req,
                        timeout=1,
                    ):
                        ready = True
                        break

                except Exception:
                    time.sleep(0.2)

            if not ready:
                raise RuntimeError(
                    "Temporary research-search function did not start."
                )

            request = urllib.request.Request(
                endpoint,
                data=json.dumps(
                    {
                        "query":
                            "ما هي أحدث الأبحاث عن التشابك الكمومي في الحواسيب الكمومية؟"
                    }
                ).encode("utf-8"),
                headers={
                    "Content-Type": "application/json",
                },
                method="POST",
            )

            try:
                with urllib.request.urlopen(
                    request,
                    timeout=15,
                ) as response:
                    status = response.status
                    result = json.load(response)

            except urllib.error.HTTPError as error:
                status = error.code
                result = json.load(error)

            check(
                status == 200,
                f"Expected HTTP 200, got {status}: {result}",
            )

            check(
                calls["scientific_query"] == 1,
                "Scientific Query should be called exactly once.",
            )

            check(
                calls["rate_limit"] == 1,
                "Rate limit should be reserved exactly once.",
            )

            canonical = \
                "quantum entanglement in quantum computing"

            check(
                any(
                    canonical in q
                    for q in seen_provider_queries
                ),
                "Canonical English query was not sent to providers.",
            )

            check(
                not any(
                    "التشابك الكمومي" in q
                    for q in seen_provider_queries
                ),
                "Arabic original query leaked into provider query path.",
            )

            check(
                result.get("query")
                == "ما هي أحدث الأبحاث عن التشابك الكمومي في الحواسيب الكمومية؟",
                "Original user query was not preserved in response.",
            )

            intent = result.get("intent") or {}

            check(
                intent.get("openAccessOnly") is True,
                "Scientific open-access constraint was not applied.",
            )

            check(
                intent.get("requestedDocumentType")
                == "systematic-review",
                "Scientific document-type constraint was not applied.",
            )

            print(
                "PASS: Scientific Query success path uses canonical English provider query"
            )
            print(
                f"PASS: Scientific Query calls = {calls['scientific_query']}"
            )
            print(
                f"PASS: Provider queries checked = {len(seen_provider_queries)}"
            )

    finally:
        if process is not None:
            process.terminate()

            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()

        mock.shutdown()
        mock.server_close()
        thread.join(timeout=2)


if __name__ == "__main__":
    main()
