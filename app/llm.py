"""LLM 分析层:摘要 / 章节 / 待办 / 关键词。

对接任意 OpenAI 兼容端点(默认本机 Ollama)。
长转写文本自动走 map-reduce:分段总结 → 汇总。
"""
import json
import re
import time

import httpx

from . import config

SYSTEM_PROMPT = "你是专业的会议纪要助手,擅长从会议转写稿中提取结构化信息。"

# 视为"临时故障、可重试"的 HTTP 状态码
_RETRY_STATUS = {408, 409, 425, 429, 500, 502, 503, 504}


class LLMError(RuntimeError):
    pass


class JobCancelled(RuntimeError):
    """任务被用户在任务中心终止。"""


def _check_job(check) -> None:
    """分块循环里的协作式检查点:pause 时挂起等待,cancel 时抛异常。"""
    if not check:
        return
    st = check()
    while st == "pause":
        time.sleep(0.5)
        st = check()
    if st == "cancel":
        raise JobCancelled()


def _chat(messages: list[dict], temperature: float = 0.3,
          timeout: float = 120, max_retries: int = 3,
          base_url: str | None = None, api_key: str | None = None,
          model: str | None = None) -> str:
    """调用 OpenAI 兼容端点。对网络抖动/限流/5xx 自动重试(指数退避)。

    base_url/api_key/model 可覆盖全局配置(翻译专用本地端点用)。
    连续失败则抛 LLMError —— 调用方(如标点恢复)会回退保留原文,不丢内容。
    """
    eff_base = base_url or config.LLM_BASE_URL
    if not eff_base.strip():
        raise LLMError("未配置 LLM 服务地址,请先在「设定」中填写 Base URL")
    url = f"{eff_base.rstrip('/')}/chat/completions"
    payload = {"model": model or config.LLM_MODEL, "messages": messages,
               "temperature": temperature}
    headers = {"Authorization": f"Bearer {api_key or config.LLM_API_KEY}"}
    last_err = "未知错误"
    for attempt in range(max_retries):
        try:
            resp = httpx.post(url, headers=headers, json=payload, timeout=timeout)
            if resp.status_code in _RETRY_STATUS:
                last_err = f"HTTP {resp.status_code}"
                time.sleep(1.5 * (attempt + 1))
                continue
            resp.raise_for_status()
            return resp.json()["choices"][0]["message"]["content"]
        except (httpx.ConnectError, httpx.ConnectTimeout, httpx.ReadTimeout,
                httpx.WriteTimeout, httpx.PoolTimeout, httpx.RemoteProtocolError) as e:
            last_err = f"{type(e).__name__}: {e}"
            time.sleep(1.5 * (attempt + 1))
            continue
        except httpx.HTTPStatusError as e:
            raise LLMError(
                f"LLM 服务返回错误 {e.response.status_code}: {e.response.text[:300]}"
            ) from e
        except (KeyError, ValueError, json.JSONDecodeError) as e:
            raise LLMError(f"LLM 响应格式异常: {e}") from e
    # 重试用尽
    if "Connect" in last_err:
        raise LLMError(
            f"无法连接 LLM 服务({eff_base})。请确认服务已启动,"
            "或在「API 设置」中检查端点配置。"
        )
    raise LLMError(f"LLM 调用连续 {max_retries} 次失败: {last_err}")


def _extract_json(text: str) -> dict:
    """从 LLM 回复中提取 JSON 对象(容忍 ```json 围栏和前后杂文本)。"""
    text = text.strip()
    fence = re.search(r"```(?:json)?\s*(.*?)```", text, re.S)
    if fence:
        text = fence.group(1).strip()
    start = text.find("{")
    if start == -1:
        raise LLMError(f"LLM 未返回有效 JSON:{text[:200]}")
    # 从第一个 { 开始做括号配平
    depth = 0
    for i in range(start, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                return json.loads(text[start:i + 1])
    raise LLMError("LLM 返回的 JSON 不完整")


def _timestamped_transcript(sentences: list[dict]) -> str:
    """[mm:ss] 文本 —— 让 LLM 能在章节里引用时间点。"""
    lines = []
    for s in sentences:
        m, sec = divmod(int(s["start"]), 60)
        h, m = divmod(m, 60)
        ts = f"{h:d}:{m:02d}:{sec:02d}" if h else f"{m:02d}:{sec:02d}"
        lines.append(f"[{ts}] {s['text']}")
    return "\n".join(lines)


def _ts_to_seconds(ts: str) -> float:
    parts = [float(p) for p in str(ts).split(":")]
    while len(parts) < 3:
        parts.insert(0, 0)
    h, m, s = parts[-3:]
    return h * 3600 + m * 60 + s


ANALYSIS_PROMPT = """请分析以下会议/音频转写稿,输出一个 JSON 对象(不要输出其他内容):
{
  "title": "给这段内容起一个简洁的标题",
  "summary": "全文摘要,200字以内,分要点用换行分隔",
  "chapters": [{"time": "mm:ss 或 hh:mm:ss", "title": "章节标题", "detail": "该章节一两句话概要"}],
  "todos": [{"task": "待办事项", "owner": "负责人(转写中没提到则留空字符串)", "due": "截止时间(没提到则留空字符串)"}],
  "keywords": ["关键词1", "关键词2"]
}
要求:
- chapters 的 time 必须来自转写稿中真实出现的时间戳,3~8 个章节;
- 没有待办事项时 todos 返回空数组,不要编造;
- 全部内容使用与转写稿相同的语言。

转写稿:
{transcript}"""


def _analyze_chunk(transcript: str) -> dict:
    # 用 replace 而非 str.format:提示词里的 JSON 示例含字面量花括号
    prompt = ANALYSIS_PROMPT.replace("{transcript}", transcript)
    out = _chat([
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": prompt},
    ])
    return _extract_json(out)


def _merge_analyses(parts: list[dict]) -> dict:
    """map-reduce 的 reduce 步:把分段分析合并成最终 JSON。"""
    digest = "\n\n".join(
        f"【第{i + 1}部分】\n摘要:{p.get('summary', '')}\n章节:" +
        "; ".join(f"{c.get('time', '')} {c.get('title', '')}"
                  for c in _entries(p.get("chapters")))
        for i, p in enumerate(parts)
    )
    todos = [t for p in parts for t in _entries(p.get("todos"))]
    keywords = list(dict.fromkeys(k for p in parts for k in p.get("keywords", [])))[:12]
    out = _chat([
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": (
            "以下是一段长音频分部分分析的结果,请合并输出一个最终 JSON 对象"
            "(格式同输入: title/summary/chapters/todos/keywords,不要输出其他内容):\n"
            "章节需保留原有时间点、按时间排序、合并相邻同主题章节至 3~10 个;\n"
            f"待办事项去重。\n\n{digest}\n\n待办事项原始列表:\n{json.dumps(todos, ensure_ascii=False)}\n"
            f"关键词:{json.dumps(keywords, ensure_ascii=False)}"
        )},
    ])
    merged = _extract_json(out)
    merged.setdefault("todos", todos)
    merged.setdefault("keywords", keywords)
    return merged


MERGE_PROMPT = """以下是语音识别产生的碎片文本(被错误地切成了很多短句),每行以"编号. "开头。
请把语义上属于同一句的连续碎片**合并**成完整、通顺的句子,并加上正确标点。

输出格式(每个合并后的句子占一行):
起始编号-结束编号. 合并并加标点后的句子

示例——若输入:
1. 我们还接通了
2. 一百多项三方的
3. MCP技能
4. 好
则输出:
1-3. 我们还接通了一百多项三方的MCP技能。
4-4. 好。

严格要求:
1. 编号区间必须连续覆盖所有输入行,不重不漏,且按顺序输出;
2. 只允许合并碎片和添加标点,**不得增、删、改写任何文字**;
3. 单独就能成句的碎片用「n-n. 文本」;
4. 不要输出任何解释。

输入:
{lines}"""


_ENUM_RE = re.compile(
    r"^\s*(?:[\(（]\s*\d{1,5}\s*[\)）]|\d{1,5}\s*[.、:：)）．,]|[\u2460-\u2473])\s*")
_LABEL_RE = re.compile(r"(?:译文|翻譯|翻译|translation)\s*[:：]\s*(.+)$", re.I)


def _clean_zh(text: str) -> str:
    """去掉小模型常混入的行号/序号/标签/原文回显。"""
    t = (text or "").strip()
    prev = None
    while prev != t:                      # 反复剥前导序号("1. 2. xxx")
        prev = t
        t = _ENUM_RE.sub("", t)
    m = _LABEL_RE.search(t)               # "うん。 译文:嗯。" → "嗯。"
    if m:
        t = m.group(1).strip()
    return t.strip()


def _parse_numbered(text: str) -> dict[int, str]:
    """解析 "编号. 文本" 行,返回 {编号: 文本};非编号行视为上一条的折行续接。"""
    out: dict[int, str] = {}
    last = None
    for line in text.splitlines():
        m = re.match(r"^\s*(\d{1,5})[.、:：]\s*(.*)$", line)
        if m:
            last = int(m.group(1))
            out[last] = m.group(2).strip()
        elif last is not None and line.strip():
            out[last] += line.strip()
    return out


def _parse_ranges(text: str) -> list[tuple[int, int, str]]:
    """解析 "a-b. 文本" 行,返回 [(a, b, text), ...](1-based,含端点)。"""
    groups = []
    for line in text.splitlines():
        m = re.match(r"^\s*(\d{1,5})\s*[-–~]\s*(\d{1,5})\s*[.、:：]\s*(.*)$", line)
        if m:
            a, b, t = int(m.group(1)), int(m.group(2)), m.group(3).strip()
            groups.append((a, b, t))
        else:  # 容错:单编号 "n. 文本"
            m2 = re.match(r"^\s*(\d{1,5})\s*[.、:：]\s*(.*)$", line)
            if m2:
                n, t = int(m2.group(1)), m2.group(2).strip()
                groups.append((n, n, t))
    return groups


_PUNCT_CHARS = "。，、;;:!?.,;:!?…—～~「」『』()()\"' \t\r\n"


def _strip_for_compare(t: str) -> str:
    """去掉标点和空白,用于校验 LLM 没有增删改文字。"""
    return "".join(ch for ch in t if ch not in _PUNCT_CHARS)


def punctuate(sentences: list[dict], chunk_size: int = 80,
              progress=None, check=None) -> tuple[list[dict], int]:
    """LLM 合并碎片 + 恢复标点。返回 (新句子列表, 失败块数)。

    - 时间戳:合并句取「首个碎片的 start → 末个碎片的 end」,字音对齐不丢。
    - 内容安全:校验合并文本(去标点后)与碎片拼接一致;若 LLM 改了字,
      回退用碎片原文拼接(宁可标点不完美也不丢内容)。
    - 任何解析失败/区间错乱的碎片,原样保留为独立句。
    """
    if not sentences:
        return [], 0
    n_chunks = (len(sentences) + chunk_size - 1) // chunk_size

    def work(ci: int):
        _check_job(check)
        chunk = sentences[ci * chunk_size:(ci + 1) * chunk_size]
        lines = "\n".join(f"{i + 1}. {s['text']}" for i, s in enumerate(chunk))
        fail = 0
        try:
            # 标点专用槽位(如本地 3B);槽位端点失败自动回退全局端点
            raw_out = _chat([
                {"role": "system", "content": "你是语音转写文本的断句与标点校对员。"},
                {"role": "user", "content": MERGE_PROMPT.replace("{lines}", lines)},
            ], temperature=0.0, timeout=90)
            groups = _parse_ranges(raw_out)
        except LLMError:
            fail = 1
            groups = []

        # 按顺序消费 groups,保证覆盖每个碎片、不乱序
        groups.sort(key=lambda g: g[0])
        items: list[dict] = []
        i = 0  # 0-based 指向 chunk 内下一个未处理碎片
        for a, b, text in groups:
            a0, b0 = a - 1, b - 1  # 转 0-based
            if a0 < i or b0 >= len(chunk) or a0 > b0:
                continue  # 区间重叠/越界/倒退 → 跳过(这些碎片稍后原样输出)
            while i < a0:
                items.append({**chunk[i], "text": chunk[i]["text"].strip()})
                i += 1
            raw_concat = "".join(chunk[k]["text"] for k in range(a0, b0 + 1))
            final_text = text if _strip_for_compare(text) == _strip_for_compare(raw_concat) else raw_concat
            items.append({
                "start": chunk[a0]["start"],
                "end": chunk[b0]["end"],
                "text": final_text.strip(),
            })
            i = b0 + 1
        while i < len(chunk):
            items.append({**chunk[i], "text": chunk[i]["text"].strip()})
            i += 1
        return ci, items, fail

    return _run_parallel(work, n_chunks, progress)


CHAT_MAX_CHARS = 60000


def _sample_context(transcript: str) -> str:
    """超长转写稿按行均匀采样(带省略标记),保证全篇都有覆盖。"""
    if len(transcript) <= CHAT_MAX_CHARS:
        return transcript
    lines = transcript.split("\n")
    step = max(1, -(-len(lines) // 300))
    out: list[str] = []
    for i in range(0, len(lines), step):
        if i:
            out.append(f"…(省略约 {step - 1} 行)…")
        out.append(lines[i])
    if lines and (len(lines) - 1) % step:
        out.append(lines[-1])
    return "\n".join(out)  # deepseek-chat 64k token 上下文,中文约 1 字 1 token,留余量


def chat_with_transcript(sentences: list[dict], analysis: dict | None,
                         messages: list[dict]) -> str:
    """带着转写稿上下文与用户对话(Manet 的「问答」)。

    转写稿全文塞入上下文;超长时保留 AI 摘要 + 首尾部分。
    """
    transcript = _sample_context(_timestamped_transcript(sentences))
    summary_block = ""
    if analysis and analysis.get("summary"):
        summary_block = (
            "\n【已生成的摘要】\n" + analysis["summary"]
            + "\n【章节】\n" + "; ".join(
                f"{c.get('time', '')} {c.get('title', '')}"
                for c in analysis.get("chapters", []))
            + "\n"
        )
    system = (
        "你是音频/视频转写笔记应用的问答助手。下面是这段录音的转写稿"
        "(每行以 [时间点] 开头)。请依据内容回答用户问题;"
        "回答时尽量注明对应时间点(如 12:35),内容中没有的信息要明确说不知道,不要编造。"
        f"{summary_block}\n【转写稿】\n{transcript}"
    )
    return _chat([{"role": "system", "content": system}] + messages,
                 temperature=0.3, timeout=120)


MINDMAP_PROMPT = """根据以下带时间戳的转写稿,生成一棵三层思维导图,只输出 JSON:
{
  "title": "中心主题(≤15字)",
  "children": [
    {
      "title": "一级分支/章节(≤15字)",
      "time": "该章节开始的 mm:ss 或 hh:mm:ss(必须来自转写稿真实时间戳)",
      "children": [{"title": "要点(≤20字)"}]
    }
  ]
}
要求:一级分支 4~9 个、按时间顺序;每个分支 2~6 个要点;要点之间不重复;
不要输出 JSON 以外的任何内容。

转写稿:
{transcript}"""


def _sanitize_tree(node, depth: int = 0) -> dict | None:
    """校验/裁剪 LLM 返回的树:限深度 3、限宽度,时间戳转秒。"""
    if not isinstance(node, dict):
        return None
    title = str(node.get("title", "")).strip()[:60]
    if not title:
        return None
    item: dict = {"title": title}
    t = node.get("time")
    if isinstance(t, (int, float)):
        item["seconds"] = float(t)
    elif isinstance(t, str):
        try:
            item["seconds"] = _ts_to_seconds(t.strip())
            item["time"] = t.strip()
        except (ValueError, TypeError):
            pass
    if depth < 2:
        kids = []
        limit = 10 if depth == 0 else 8
        for c in (node.get("children") or [])[:limit]:
            s = _sanitize_tree(c, depth + 1)
            if s:
                kids.append(s)
        if kids:
            item["children"] = kids
    return item


def mindmap(sentences: list[dict]) -> dict:
    """生成思维导图树(根 → 章节[带时间] → 要点)。"""
    transcript = _sample_context(_timestamped_transcript(sentences))
    out = _chat([
        {"role": "system", "content": "你是思维导图结构化专家,只输出 JSON。"},
        {"role": "user", "content": MINDMAP_PROMPT.replace("{transcript}", transcript)},
    ], temperature=0.3, timeout=180)
    tree = _sanitize_tree(_extract_json(out))
    if not tree:
        raise LLMError("LLM 未返回有效的思维导图结构")
    return tree


TRANSLATE_PROMPT = """把以下带编号的文本逐条翻译成中文(简体)。
要求:
1. 输出行数与输入完全一致,每行以原编号开头,格式"编号. 译文";
2. 译文流畅自然,符合中文表达习惯,专有名词用通用译名;
3. 不增删内容,每条占一行;
4. 译文里不得出现行号、序号、"译文:"等任何标签或标记;
5. 不要输出任何其他内容。

{lines}"""


def _translate_once(lines: str) -> str:
    """按设置分发:本地 mlx-lm(进程内)或 API 端点。"""
    msgs = [
        {"role": "system", "content": "你是专业的字幕翻译,只输出译文行。"},
        {"role": "user", "content": TRANSLATE_PROMPT.replace("{lines}", lines)},
    ]
    if config.TRANSLATE_MODE == "local":
        from . import local_llm
        return local_llm.generate_text(msgs, max_tokens=3000)
    return _chat(msgs, temperature=0.2, timeout=300)


def translate(sentences: list[dict], chunk_size: int = 50,
              progress=None, check=None) -> tuple[list[str], int]:
    """逐句翻译成中文,返回 (与 sentences 等长的译文列表, 失败块数)。

    编号严格对齐;失败/缺失的行返回空串(前端回退显示原文)。
    """
    if not sentences:
        return [], 0
    n_chunks = (len(sentences) + chunk_size - 1) // chunk_size

    def work(ci: int):
        _check_job(check)
        chunk = sentences[ci * chunk_size:(ci + 1) * chunk_size]
        lines = "\n".join(f"{i + 1}. {s['text']}" for i, s in enumerate(chunk))
        fail = 0
        try:
            raw = _translate_once(lines)
            parsed = _parse_numbered(raw)
        except LLMError:
            fail = 1
            parsed = {}
        texts = [_clean_zh(parsed.get(i + 1, "")) for i in range(len(chunk))]
        return ci, texts, fail

    # 本地模型有生成锁,并行无意义且浪费线程,直接顺序跑
    local_mode = config.TRANSLATE_MODE == "local"
    out, failed = _run_parallel(work, n_chunks, progress,
                                workers=1 if local_mode else None)
    if failed >= n_chunks:
        raise LLMError("翻译全部分块失败,请检查 API 服务是否可用(或改用本地翻译)")
    return out, failed


def _run_parallel(work, n_chunks: int, progress=None,
                  workers: int | None = None) -> tuple[list, int]:
    """并行执行分块任务(翻译/标点的块彼此独立)。

    work(ci) -> (ci, 结果列表, 失败标志);按块序拼接结果,进度回调线程安全。
    workers=1 时直接顺序执行,不开线程池(本地模型场景下有加锁,并行无意义)。
    """
    results: dict[int, list] = {}
    failed = 0
    done = 0
    w = max(1, min(workers or int(config.LLM_PARALLEL), n_chunks))

    def _on_result(ci: int, items: list, fail: int):
        nonlocal done, failed
        results[ci] = items
        failed += fail
        done += 1
        if progress:
            progress(done, n_chunks)

    if w <= 1:
        # 顺序执行——本地模型串行生成时避免无谓线程开销
        for ci in range(n_chunks):
            _check_job(None)
            ci_, items, fail = work(ci)
            _on_result(ci_, items, fail)
    else:
        from concurrent.futures import ThreadPoolExecutor, as_completed
        import threading
        lock = threading.Lock()
        with ThreadPoolExecutor(max_workers=w) as ex:
            futs = [ex.submit(work, ci) for ci in range(n_chunks)]
            for f in as_completed(futs):
                ci, items, fail = f.result()   # JobCancelled 等异常在此向上传播
                results[ci] = items
                failed += fail
                with lock:
                    done += 1
                    if progress:
                        progress(done, n_chunks)
    out = [x for ci in range(n_chunks) for x in results.get(ci, [])]
    return out, failed


def llm_available() -> bool:
    """快速探测 LLM 端点是否可用(用于决定是否自动润色)。"""
    try:
        resp = httpx.get(
            f"{config.LLM_BASE_URL.rstrip('/')}/models",
            headers={"Authorization": f"Bearer {config.LLM_API_KEY}"},
            timeout=5,
        )
        return resp.status_code == 200
    except Exception:  # noqa: BLE001
        return False


CONDENSE_PROMPT = """以下是长转写稿的一部分。请把它提炼成要点式梗概,保留关键事实、观点、数据、结论、人名与专有名词,去掉口语冗余、重复和语气词。
直接输出提炼后的梗概,不要输出任何说明或前缀。

{transcript}"""


def _essay_once(text: str) -> str:
    prompt = config.ESSAY_PROMPT
    if "{transcript}" in prompt:
        prompt = prompt.replace("{transcript}", text)
    else:
        prompt = prompt + "\n\n转写稿:\n" + text
    out = _chat([
        {"role": "system", "content": "你是文笔凝练、逻辑清晰的随笔作家。"},
        {"role": "user", "content": prompt},
    ], temperature=0.5, timeout=300)
    return (out or "").strip()


def essay(sentences: list[dict], check=None) -> str:
    """把转写稿改写为一篇主旨明确、内容精炼的随笔文章(纯文本)。"""
    transcript = _timestamped_transcript(sentences)
    if not transcript.strip():
        raise LLMError("转写稿为空,无法生成随笔")

    if len(transcript) <= config.LLM_MAX_CHARS:
        _check_job(check)
        return _essay_once(transcript)

    # map-reduce:超长稿先分块提炼,再汇总成文
    lines = transcript.split("\n")
    chunks, buf = [], ""
    for line in lines:
        if len(buf) + len(line) + 1 > config.LLM_MAX_CHARS and buf:
            chunks.append(buf)
            buf = line
        else:
            buf = buf + "\n" + line if buf else line
    if buf:
        chunks.append(buf)

    def _work(ci):
        _check_job(check)
        out = _chat([
            {"role": "system", "content": "你是信息提炼专家,擅长从口语转写稿中提取要点。"},
            {"role": "user", "content": CONDENSE_PROMPT.replace("{transcript}", chunks[ci])},
        ], temperature=0.4, timeout=300)
        return ci, [(out or "").strip()], 0

    results, _ = _run_parallel(_work, len(chunks))
    _check_job(check)
    digest = "\n\n".join(
        f"【第{i + 1}部分要点】\n{t}" for i, t in enumerate(results))
    return _essay_once(digest)


TITLES_PROMPT = """为以下转写稿起 {n} 个彼此不同的标题,每行一个。
要求:
1. 角度或句式彼此不同(主题式 / 对象式 / 结论式 / 疑问式等);
2. 每个 20 字以内,体现内容核心;
3. 不得与下列已有标题雷同或仅差个别字:{exclude}
4. 只输出 {n} 行标题,不要编号、引号、书名号或任何解释。

转写稿:
{transcript}"""


def suggest_titles(sentences: list[dict], exclude: list[str] | None = None,
                   n: int = 3) -> list[str]:
    """标题优化:一次生成 n 个互不相同的候选标题(供逐次切换)。"""
    exclude = exclude or []
    transcript = _sample_context(_timestamped_transcript(sentences))
    ex = "、".join(f"《{t}》" for t in exclude[-8:]) or "(无)"
    out = _chat([
        {"role": "system", "content": "你是擅长拟标题的编辑。"},
        {"role": "user", "content": TITLES_PROMPT.replace("{n}", str(n))
            .replace("{exclude}", ex).replace("{transcript}", transcript)},
    ], temperature=0.7, timeout=60)
    seen, res = set(exclude), []
    for line in (out or "").splitlines():
        t = re.sub(r"^\d+\s*[.、)）]\s*", "", line.strip()).strip("\"'“”‘’《<>[] ")
        if t and t not in seen:
            seen.add(t)
            res.append(t[:60])
    return res


_TS_HEAD_RE = re.compile(r"^(\d{1,2}:\d{2}(?::\d{2})?)\s*[—\-–:：、.]?\s*(.*)$")


def _entries(v) -> list[dict]:
    """LLM 偶发把 chapters/todos 返回成字符串列表 → 统一成 dict。

    字符串可能是多章节挤在一行("00:13 开场；00:57 主题"),按分号拆段,
    并把每段开头的时间戳提取进 time 字段(否则前端章节跳转拿不到时间)。
    """
    out = []
    for x in v or []:
        if isinstance(x, dict):
            out.append(x)
        elif isinstance(x, str):
            for part in re.split(r"[；;]\s*", x.strip()):
                part = part.strip()
                if not part:
                    continue
                m = _TS_HEAD_RE.match(part)
                if m and m.group(2):
                    out.append({"time": m.group(1), "title": m.group(2).strip(),
                                "task": part})
                else:
                    out.append({"title": part, "task": part})
    return out


def analyze(sentences: list[dict], check=None) -> dict:
    """完整分析入口。返回 {title, summary, chapters, todos, keywords}。"""
    transcript = _timestamped_transcript(sentences)
    if not transcript.strip():
        raise LLMError("转写稿为空,无法分析")

    if len(transcript) <= config.LLM_MAX_CHARS:
        _check_job(check)
        analysis = _analyze_chunk(transcript)
    else:
        # map-reduce:按行切块
        lines = transcript.split("\n")
        chunks, buf = [], ""
        for line in lines:
            if len(buf) + len(line) + 1 > config.LLM_MAX_CHARS and buf:
                chunks.append(buf)
                buf = line
            else:
                buf = buf + "\n" + line if buf else line
        if buf:
            chunks.append(buf)
        # 并行处理各块(每块独立,与翻译/标点同理)
        def _work(ci):
            _check_job(check)
            return ci, [_analyze_chunk(chunks[ci])], 0
        results, _ = _run_parallel(_work, len(chunks))
        _check_job(check)
        analysis = _merge_analyses(results)

    # 归一化:LLM 偶发把 chapters/todos 返回成字符串列表(此前导致 .get 崩溃)
    if not isinstance(analysis, dict):
        raise LLMError("LLM 未返回有效的分析结构")
    analysis["chapters"] = _entries(analysis.get("chapters"))
    analysis["todos"] = _entries(analysis.get("todos"))
    analysis["keywords"] = [str(k).strip()
                            for k in (analysis.get("keywords") or [])
                            if str(k).strip()][:12]
    analysis.setdefault("summary", "")
    analysis.setdefault("title", "")

    # 章节时间字符串 → 秒,方便前端跳转
    for ch in analysis.get("chapters", []):
        try:
            ch["seconds"] = _ts_to_seconds(ch.get("time", "0"))
        except (ValueError, TypeError):
            ch["seconds"] = 0.0
    return analysis
