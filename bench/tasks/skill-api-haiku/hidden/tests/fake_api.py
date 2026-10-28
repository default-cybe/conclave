"""A local stand-in for POST /v1/messages that answers the way Claude Haiku 5.5 does.

It rejects with a 400 what the real model rejects (as documented for the
Haiku 4.5 -> Haiku 5.5 move) and answers like it: adaptive thinking is on
unless the request turns it off, a response starts with a thinking block
whose text is empty, thinking counts toward max_tokens, and a declined
request is an HTTP 200 with stop_reason "refusal". Labels come from keywords,
so the answers are deterministic.

Known limit: no streaming (stream: true is a 400 here, the real API accepts it).
"""

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TARGET = "claude-haiku-5-5"

TOP_LEVEL = {
    "model", "max_tokens", "messages", "system", "thinking", "output_config", "metadata",
    "stop_sequences", "stream", "tools", "tool_choice", "temperature", "top_p", "top_k",
    "service_tier", "fallbacks", "container", "context_management", "mcp_servers",
}
EFFORTS = ("low", "medium", "high", "xhigh", "max")
THINK_COST = {"low": 150, "medium": 400, "high": 900, "xhigh": 2000, "max": 2000}
ANSWER_COST = 12

KEYWORDS = [
    ("billing", ("charged", "refund", "invoice", "receipt", "card")),
    ("technical", ("crash", "error", "broken", "white screen", "500")),
    ("account", ("log in", "login", "password", "2fa", "locked out")),
    ("feature_request", ("would be nice", "please add", "could you add", "dark mode")),
]
REFUSE = ("malware", "ransomware")


class BadRequest(Exception):
    def __init__(self, status, kind, message):
        super().__init__(message)
        self.status, self.kind, self.message = status, kind, message


def _text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")
    return ""


def label_for(text):
    t = text.lower()
    for label, words in KEYWORDS:
        if any(w in t for w in words):
            return label
    return "other"


def check(body):
    """Raise BadRequest for what the real model rejects. Returns (thinking_on, effort)."""
    if not isinstance(body, dict):
        raise BadRequest(400, "invalid_request_error", "body must be a JSON object")
    for k in body:
        if k not in TOP_LEVEL:
            raise BadRequest(400, "invalid_request_error", f"{k}: Extra inputs are not permitted")
    model = body.get("model")
    if model != TARGET:
        raise BadRequest(404, "not_found_error", f"model: {model} (this test server serves {TARGET} only)")
    if body.get("stream"):
        raise BadRequest(400, "invalid_request_error", "stream: not supported by this test server")
    mt = body.get("max_tokens")
    if not isinstance(mt, int) or isinstance(mt, bool) or mt < 1:
        raise BadRequest(400, "invalid_request_error", "max_tokens: Field required (a positive integer)")
    if mt > 128000:
        raise BadRequest(400, "invalid_request_error", "max_tokens: must be at most 128000 for this model")
    if "top_k" in body:
        raise BadRequest(400, "invalid_request_error", "top_k: is not supported for this model")
    if "temperature" in body and "top_p" in body:
        raise BadRequest(400, "invalid_request_error", "temperature and top_p cannot both be specified for this model")
    if "temperature" in body and body["temperature"] != 1:
        raise BadRequest(400, "invalid_request_error", "temperature: only the default value 1 is supported for this model")
    if "top_p" in body and body["top_p"] != 0.99:
        raise BadRequest(400, "invalid_request_error", "top_p: only the default value 0.99 is supported for this model")
    if "fallbacks" in body:
        raise BadRequest(400, "invalid_request_error", "fallbacks: server-side fallback is not available for this model")
    oc = body.get("output_config") or {}
    if not isinstance(oc, dict):
        raise BadRequest(400, "invalid_request_error", "output_config: must be an object")
    for k in oc:
        if k not in ("effort", "format", "task_budget"):
            raise BadRequest(400, "invalid_request_error", f"output_config.{k}: Extra inputs are not permitted")
    effort = oc.get("effort", "medium")
    if effort not in EFFORTS:
        raise BadRequest(400, "invalid_request_error", f"output_config.effort: must be one of {', '.join(EFFORTS)}")
    fmt = oc.get("format")
    if fmt is not None and not (isinstance(fmt, dict) and fmt.get("type") == "json_schema" and isinstance(fmt.get("schema"), dict)):
        raise BadRequest(400, "invalid_request_error", 'output_config.format: expected {"type": "json_schema", "schema": {...}}')
    thinking = body.get("thinking")
    thinking_on = True
    if thinking is not None:
        if not isinstance(thinking, dict):
            raise BadRequest(400, "invalid_request_error", "thinking: must be an object")
        kind = thinking.get("type")
        if "budget_tokens" in thinking or kind == "enabled":
            raise BadRequest(400, "invalid_request_error", '"thinking.type.enabled" is not supported for this model. Use "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.')
        if kind == "between_tools":
            raise BadRequest(400, "invalid_request_error", '"thinking.type.between_tools" is not supported for this model.')
        if kind not in ("adaptive", "disabled"):
            raise BadRequest(400, "invalid_request_error", f"thinking.type: unknown value {kind!r}")
        if kind == "disabled":
            if effort in ("xhigh", "max"):
                raise BadRequest(400, "invalid_request_error", f"output_config.effort '{effort}' is not supported when thinking is disabled on this model. Use effort 'high' or below, or enable thinking.")
            thinking_on = False
    msgs = body.get("messages")
    if not isinstance(msgs, list) or not msgs:
        raise BadRequest(400, "invalid_request_error", "messages: at least one message is required")
    for i, m in enumerate(msgs):
        if not isinstance(m, dict) or m.get("role") not in ("user", "assistant"):
            raise BadRequest(400, "invalid_request_error", f"messages.{i}.role: must be user or assistant")
    if msgs[-1]["role"] != "user":
        raise BadRequest(400, "invalid_request_error", "This model does not support assistant message prefill. The conversation must end with a user message.")
    return thinking_on, effort, fmt


def tool_answer(body, tools, label, base, thinking_on, effort):
    """Answer with a tool call. A forced tool_choice (any or a named tool) skips thinking."""
    choice = body.get("tool_choice") or {"type": "auto"}
    kind = choice.get("type") if isinstance(choice, dict) else None
    if kind not in ("auto", "any", "tool"):
        raise BadRequest(400, "invalid_request_error", f"tool_choice.type: unknown value {kind!r}")
    tool = tools[0]
    if kind == "tool":
        tool = next((t for t in tools if t["name"] == choice.get("name")), None)
        if tool is None:
            raise BadRequest(400, "invalid_request_error", f"tool_choice.name: no tool named {choice.get('name')!r}")
    props = ((tool.get("input_schema") or {}).get("properties") or {})
    # fill the property whose enum holds the labels; a plain "label" field otherwise
    key = next((k for k, v in props.items() if isinstance(v, dict) and label in (v.get("enum") or [])), "label")
    call = {"type": "tool_use", "id": "toolu_fake", "name": tool["name"], "input": {key: label}}
    content, used, budget = [], 0, body["max_tokens"]
    if thinking_on and kind == "auto":
        cost = THINK_COST[effort]
        content.append({"type": "thinking", "thinking": "", "signature": "EqQBCkgIBhABGAIiQFakeSignatureForTests"})
        used = min(cost, budget)
        if cost + ANSWER_COST > budget:
            return {**base, "content": content, "stop_reason": "max_tokens", "usage": {"input_tokens": 50, "output_tokens": used}}
    if used + ANSWER_COST > budget:
        return {**base, "content": content, "stop_reason": "max_tokens", "usage": {"input_tokens": 50, "output_tokens": budget}}
    return {**base, "content": content + [call], "stop_reason": "tool_use", "usage": {"input_tokens": 50, "output_tokens": used + ANSWER_COST}}


def answer(body, thinking_on, effort, fmt):
    user = _text_of(body["messages"][-1].get("content"))
    system = body.get("system")
    system_text = system if isinstance(system, str) else _text_of(system)
    base = {"id": "msg_fake", "type": "message", "role": "assistant", "model": TARGET, "stop_sequence": None}
    if any(w in user.lower() for w in REFUSE):
        return {**base, "content": [], "stop_reason": "refusal", "stop_details": {"type": "refusal", "category": "cyber", "explanation": None}, "usage": {"input_tokens": 50, "output_tokens": 0}}
    label = label_for(user)
    tools = [t for t in body.get("tools") or [] if isinstance(t, dict) and t.get("name")]
    if tools and (body.get("tool_choice") or {}).get("type") != "none":
        return tool_answer(body, tools, label, base, thinking_on, effort)
    wants_json = fmt is not None or "json" in (system_text + " " + user).lower()
    text = json.dumps({"label": label}) if wants_json else label
    content, used = [], 0
    budget = body["max_tokens"]
    if thinking_on:
        cost = THINK_COST[effort]
        content.append({"type": "thinking", "thinking": "", "signature": "EqQBCkgIBhABGAIiQFakeSignatureForTests"})
        used = min(cost, budget)
        if cost + ANSWER_COST > budget:
            return {**base, "content": content, "stop_reason": "max_tokens", "usage": {"input_tokens": 50, "output_tokens": used}}
    if used + ANSWER_COST > budget:
        keep = max(1, (budget - used) // 2)
        return {**base, "content": content + [{"type": "text", "text": text[:keep]}], "stop_reason": "max_tokens", "usage": {"input_tokens": 50, "output_tokens": budget}}
    content.append({"type": "text", "text": text})
    return {**base, "content": content, "stop_reason": "end_turn", "usage": {"input_tokens": 50, "output_tokens": used + ANSWER_COST}}


class FakeApi:
    """Run with `with FakeApi() as api:`; api.url is the base URL, api.log the requests."""

    def __init__(self):
        self.log = []
        log = self.log

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                raw = self.rfile.read(int(self.headers.get("content-length") or 0))
                entry = {"path": self.path, "headers": {k.lower(): v for k, v in self.headers.items()}, "body": None, "status": None, "error": None}
                log.append(entry)
                try:
                    if self.path.split("?")[0] != "/v1/messages":
                        raise BadRequest(404, "not_found_error", f"no route {self.path}")
                    if not entry["headers"].get("x-api-key"):
                        raise BadRequest(401, "authentication_error", "x-api-key header is required")
                    if not entry["headers"].get("anthropic-version"):
                        raise BadRequest(400, "invalid_request_error", "anthropic-version header is required")
                    try:
                        body = json.loads(raw.decode("utf-8"))
                    except ValueError:
                        raise BadRequest(400, "invalid_request_error", "body is not JSON") from None
                    entry["body"] = body
                    out, status = answer(body, *check(body)), 200
                except BadRequest as e:
                    out, status = {"type": "error", "error": {"type": e.kind, "message": e.message}}, e.status
                    entry["error"] = e.message
                entry["status"] = status
                data = json.dumps(out).encode("utf-8")
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def __enter__(self):
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        return self

    def __exit__(self, *exc):
        self.server.shutdown()
        self.server.server_close()

    def errors(self):
        return [(e["status"], e["error"]) for e in self.log if e["status"] != 200]
