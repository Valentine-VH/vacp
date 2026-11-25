import hashlib
import json
import re
import subprocess
import tempfile
import time
from importlib.metadata import version
from pathlib import Path

INBOX = Path("/exchange/inbox")
OUTBOX = Path("/exchange/outbox")
ENGINE = version("cisco-ai-skill-scanner")
KEY = re.compile(r"[a-f0-9-]{36}\.[a-f0-9-]{36}\.json")
SEVERITIES = {"CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"}


def scan(job):
    content = job["content"].encode("utf-8")
    if len(content) > 64000 or hashlib.sha256(content).hexdigest() != job["digest"]:
        raise ValueError("input_integrity")
    with tempfile.TemporaryDirectory() as root:
        skill = Path(root) / "vacp-skill"
        skill.mkdir()
        if not content.startswith((b"---\n", b"---\r\n")):
            content = b"---\nname: vacp-skill\ndescription: Workspace-authored skill.\n---\n" + content
        (skill / "SKILL.md").write_bytes(content)
        report_path = Path(root) / "result.json"
        subprocess.run(
            ["skill-scanner", "scan", str(skill), "--format", "json", "--output", str(report_path)],
            cwd=root, timeout=30, check=True,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        if report_path.stat().st_size > 1024 * 1024:
            raise ValueError("report_limit")
        report = json.loads(report_path.read_bytes())
        findings = report["findings"]
        if not isinstance(findings, list) or len(findings) > 200 or report["findings_count"] != len(findings):
            raise ValueError("invalid_findings")
        if "static_analyzer" not in report["analyzers_used"]:
            raise ValueError("no_static_analyzer")
        safe = []
        for item in findings:
            severity = str(item["severity"]).upper()
            rule = str(item["rule_id"])
            if rule == "SKILL_LOAD_FALLBACK_USED":
                return {"status": "failed", "error": "invalid_skill_metadata"}
            if severity not in SEVERITIES or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,160}", rule):
                raise ValueError("unknown_finding")
            line = item.get("line_number")
            safe.append({"severity": severity, "rule": rule, "line": line if type(line) is int else None})
        return {"status": "blocked" if any(f["severity"] == "CRITICAL" for f in safe) else "passed",
                "findings": safe}


def process(path):
    job = {}
    try:
        if path.stat().st_size > 384 * 1024:
            raise ValueError("job_limit")
        job = json.loads(path.read_bytes())
        result = scan(job)
    except subprocess.TimeoutExpired:
        result = {"status": "failed", "error": "timeout"}
    except (OSError, ValueError, KeyError, TypeError, AttributeError, subprocess.SubprocessError):
        result = {"status": "failed", "error": "invalid_input_or_report"}
    result.update(engine=ENGINE, digest=job.get("digest"))
    # The Server validates generation and digest before persisting any result.
    destination = OUTBOX / path.name
    temporary = destination.with_suffix(".tmp")
    temporary.write_text(json.dumps(result), encoding="utf-8")
    temporary.replace(destination)


while True:
    for path in sorted(INBOX.glob("*.json")):
        if not KEY.fullmatch(path.name) or (OUTBOX / path.name).exists():
            continue
        try:
            process(path)
        except OSError:
            # The Server owns the lease and eventual retry or failure.
            break
    time.sleep(1)
