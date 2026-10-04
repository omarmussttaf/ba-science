"""Isolated integration tests for BA Science Hybrid Search."""

import json
import os
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "supabase/functions/hybrid-search/index.ts"
MARKER = "Deno.serve(async (request) => {"

LEXICAL = [
    {
        "key": "shared-lexical",
        "doi": "https://doi.org/10.1234/ba-shared",
        "title": "Quantum entanglement in photon systems",
        "abstract": "Quantum entanglement experiments.",
        "baScore": 92,
        "citedByCount": 50,
    },
    {
        "key": "lexical-only",
        "doi": "10.1234/ba-lexical",
        "title": "Quantum entanglement measurement techniques",
        "abstract": "Measurement of quantum entanglement.",
        "baScore": 85,
        "citedByCount": 25,
    },
]

SEMANTIC = [
    {
        "canonical_key": "shared-semantic",
        "doi": "10.1234/ba-shared",
        "title": "Quantum entanglement in photon systems",
        "semantic_similarity": 0.94,
    },
    {
        "canonical_key": "semantic-only",
        "doi": "10.1234/ba-semantic",
        "title": "Quantum entanglement experimental protocols",
        "abstract": "Quantum entanglement experiments and measurement.",
        "semantic_similarity": 0.96,
        "cited_by_count": 30,
    },
    {
        "canonical_key": "duplicate-record",
        "doi": "https://doi.org/10.1234/ba-semantic",
        "title": "Quantum entanglement experimental protocols",
        "abstract": "Quantum entanglement experiments and measurement.",
        "semantic_similarity": 0.96,
    },
]


def run_case(name, *, live=True, secret=True,
             lexical_status=200, semantic_status=200,
             semantic_delay=0, lexical_results=None,
             semantic_results=None,
             query="quantum entanglement"):
    source = SOURCE.read_text(encoding="utf-8")

    if source.count(MARKER) != 1:
        raise RuntimeError("Unexpected hybrid-search entrypoint.")

    calls = {"lexical": 0, "semantic": 0}

    class MockSupabase(BaseHTTPRequestHandler):
        def do_POST(self):
            length = int(self.headers.get("Content-Length", "0"))
            self.rfile.read(length)

            if self.path == "/functions/v1/research-search":
                calls["lexical"] += 1
                status = lexical_status
                payload = (
                    {"ok": True, "results": (
                        LEXICAL if lexical_results is None
                        else lexical_results
                    )}
                    if status == 200
                    else {"ok": False, "error": "Mock rate limit"}
                )

            elif self.path == "/functions/v1/semantic-search":
                calls["semantic"] += 1

                if semantic_delay:
                    time.sleep(semantic_delay)

                authorized = (
                    self.headers.get("x-ba-semantic-secret")
                    == "LOCAL_TEST_ONLY_SECRET"
                )
                status = semantic_status if authorized else 401
                payload = (
                    {"ok": True, "results": (
                        SEMANTIC if semantic_results is None
                        else semantic_results
                    )}
                    if status == 200
                    else {"ok": False, "error": "Mock semantic failure"}
                )

            else:
                status = 404
                payload = {"ok": False, "error": "Unexpected endpoint"}

            data = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            try:
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError):
                # Expected when Hybrid aborts a timed-out request.
                pass

        def log_message(self, *args):
            pass

    mock = ThreadingHTTPServer(("127.0.0.1", 0), MockSupabase)
    thread = threading.Thread(target=mock.serve_forever, daemon=True)
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

    process = None

    try:
        with tempfile.TemporaryDirectory(
            prefix="ba-hybrid-integration-"
        ) as folder:
            test_file = Path(folder) / "index.ts"
            test_file.write_text(modified, encoding="utf-8")

            # Explicit local-only environment; no inherited cloud secrets.
            env = {
                "PATH": os.environ.get("PATH", ""),
                "HOME": os.environ.get("HOME", ""),
                "SUPABASE_URL":
                    f"http://127.0.0.1:{mock.server_port}",
                "SUPABASE_SERVICE_ROLE_KEY": "LOCAL_TEST_ONLY",
                "BA_ENABLE_LIVE_SEMANTIC":
                    "true" if live else "false",
                "BA_SEMANTIC_INTERNAL_SECRET":
                    "LOCAL_TEST_ONLY_SECRET" if secret else "",
            }

            process = subprocess.Popen(
                [
                    "deno", "run",
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
                        endpoint, method="OPTIONS"
                    )
                    with urllib.request.urlopen(req, timeout=1):
                        ready = True
                        break
                except Exception:
                    time.sleep(0.2)

            if not ready:
                raise RuntimeError(
                    f"{name}: Temporary function did not start."
                )

            request = urllib.request.Request(
                endpoint,
                data=json.dumps({
                    "query": query
                }).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST",
            )

            try:
                with urllib.request.urlopen(
                    request, timeout=15
                ) as response:
                    status = response.status
                    result = json.load(response)
            except urllib.error.HTTPError as error:
                status = error.code
                result = json.load(error)

            return status, result, dict(calls)

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


def check(condition, message):
    if not condition:
        raise AssertionError(message)


def main():
    status, result, calls = run_case("Successful hybrid")
    rows = result.get("results") or []
    origins = Counter(row.get("hybridOrigin") for row in rows)

    dois = [
        str(row.get("doi") or "")
        .lower()
        .replace("https://doi.org/", "")
        for row in rows
    ]

    check(status == 200, "Hybrid HTTP status")
    check(result.get("mode") == "hybrid-v0.4", "Hybrid mode")
    check(result.get("semanticApplied") is True, "Semantic applied")
    check(result.get("matchedBothCount") == 1, "Shared paper matching")
    check(len(rows) == 3 and len(set(dois)) == 3, "Duplicate papers")
    check(origins == Counter({
        "both": 1,
        "lexical": 1,
        "semantic-memory": 1,
    }), "Incorrect hybrid origins")
    check(calls == {"lexical": 1, "semantic": 1}, "Call counts")
    print("PASS: Successful hybrid integration and DOI deduplication")

    status, result, calls = run_case(
        "Missing semantic secret", secret=False
    )
    check(status == 200, "Missing-secret HTTP status")
    check(result.get("mode") == "lexical-fallback", "Missing-secret mode")
    check(result.get("semanticApplied") is False, "Missing-secret semantic")
    check(calls == {"lexical": 1, "semantic": 0}, "Missing-secret calls")
    print("PASS: Missing secret uses lexical fallback")

    status, result, calls = run_case(
        "Semantic service failure", semantic_status=500
    )
    check(status == 200, "Semantic-failure HTTP status")
    check(result.get("mode") == "lexical-fallback", "Semantic-failure mode")
    check(result.get("semanticApplied") is False, "Semantic-failure flag")
    check(calls == {"lexical": 1, "semantic": 1}, "Semantic-failure calls")
    print("PASS: Semantic failure uses lexical fallback")

    started = time.monotonic()

    status, result, calls = run_case(
        "Semantic timeout",
        semantic_delay=14,
    )

    elapsed = time.monotonic() - started

    check(status == 200, "Timeout HTTP status")
    check(result.get("mode") == "lexical-fallback", "Timeout mode")
    check(result.get("semanticApplied") is False, "Timeout semantic flag")
    check(calls == {"lexical": 1, "semantic": 1}, "Timeout call counts")
    check(10 <= elapsed < 19, "Timeout duration outside expected range")

    print(f"PASS: Semantic timeout uses lexical fallback ({elapsed:.2f}s)")

    status, result, calls = run_case(
        "Lexical rate limit", lexical_status=429
    )
    check(status == 429, "Rate-limit HTTP status")
    check(result.get("ok") is False, "Rate-limit response")
    check(calls == {"lexical": 1, "semantic": 0}, "Rate-limit call ordering")
    print("PASS: HTTP 429 stops before semantic search")

    # Q05: Detect semantic drift across different application domains.
    unrelated_paper = {
        "canonical_key": "cybersecurity-quantum-ml",
        "doi": "10.1234/mock-cybersecurity",
        "title": (
            "Investigation of quantum machine learning algorithms "
            "in noisy environment for cybersecurity applications"
        ),
        "abstract": (
            "Quantum machine learning algorithms for cybersecurity "
            "and network protection."
        ),
        "semantic_similarity": 0.794,
        "cited_by_count": 5,
    }

    relevant_paper = {
        "canonical_key": "medical-ml-diagnosis",
        "doi": "10.1234/mock-medical-diagnosis",
        "title": "Machine learning for medical diagnosis",
        "abstract": (
            "Machine learning methods for medical diagnosis "
            "and clinical prediction."
        ),
        "semantic_similarity": 0.91,
        "cited_by_count": 10,
    }

    # A high embedding similarity must not automatically
    # override a missing application-domain concept.
    high_similarity_unrelated = {
        **unrelated_paper,
        "canonical_key": "high-similarity-cybersecurity",
        "doi": "10.1234/mock-high-similarity-cybersecurity",
        "semantic_similarity": 0.96,
    }

    status, result, calls = run_case(
        "Q05 semantic drift",
        lexical_results=[],
        semantic_results=[
            unrelated_paper,
            relevant_paper,
            high_similarity_unrelated,
        ],
        query="machine learning in medical diagnosis",
    )

    rows = result.get("results") or []

    print("Q05 HTTP:", status)
    print("Q05 semantic candidates:", result.get("semanticCount"))
    print("Q05 final results:", len(rows))
    print(
        "Q05 accepted origins:",
        [row.get("hybridOrigin") for row in rows],
    )

    accepted_dois = {
        str(row.get("doi") or "")
        for row in rows
    }

    check(
        accepted_dois == {"10.1234/mock-medical-diagnosis"},
        "SEMANTIC DRIFT DETECTED: Expected only the relevant "
        f"medical paper, received: {sorted(accepted_dois)}"
    )

    print("PASS: Q05 unrelated semantic result rejected")
    # Concept balance must preserve valid multi-concept results.
    positive_cases = [
        (
            "Q01 multi-concept",
            "quantum entanglement photon experiments",
            "Entanglement signatures in photon experiments",
            "Experimental quantum correlations in photon systems.",
        ),
        (
            "Q02 multi-concept",
            "quantum tunneling in nuclear fusion",
            "Tunneling effects in fusion reactions",
            "Quantum transmission through nuclear barriers.",
        ),
    ]

    for name, scientific_query, title, abstract in positive_cases:
        paper = {
            "canonical_key": name.lower().replace(" ", "-"),
            "doi": "10.1234/" + name[:3].lower() + "-positive",
            "title": title,
            "abstract": abstract,
            "semantic_similarity": 0.94,
            "cited_by_count": 12,
        }

        status, result, calls = run_case(
            name,
            query=scientific_query,
            lexical_results=[],
            semantic_results=[paper],
        )

        rows = result.get("results") or []

        check(status == 200, name + ": HTTP status")
        check(len(rows) == 1, name + ": valid paper was excluded")
        check(
            rows[0].get("hybridOrigin") == "semantic-memory",
            name + ": incorrect origin",
        )
        check(
            calls == {"lexical": 1, "semantic": 1},
            name + ": unexpected call counts",
        )

        print("PASS:", name, "relevant paper preserved")

    # Synonym regression: preserve clinically relevant terminology.
    synonym_paper = {
        "canonical_key": "clinical-screening-ml",
        "doi": "10.1234/mock-clinical-screening",
        "title": (
            "Machine learning for clinical screening "
            "and disease detection"
        ),
        "abstract": (
            "Machine learning methods for clinical screening "
            "and detecting diseases in patients."
        ),
        "semantic_similarity": 0.94,
        "cited_by_count": 20,
    }

    status, result, calls = run_case(
        "Q05 scientific synonyms",
        query="machine learning in medical diagnosis",
        lexical_results=[],
        semantic_results=[synonym_paper],
    )

    rows = result.get("results") or []

    print("Synonym test HTTP:", status)
    print("Synonym test accepted papers:", len(rows))

    check(status == 200, "Synonym test HTTP status")
    check(
        len(rows) == 1,
        "FALSE NEGATIVE: Clinically relevant synonym paper excluded."
    )
    check(
        rows[0].get("hybridOrigin") == "semantic-memory",
        "Synonym test incorrect origin",
    )

    print("PASS: Scientific synonym paper preserved")
    print("OVERALL: PASS (9 scenarios)")


if __name__ == "__main__":
    main()
