# ChatUI Frontend API Quickstart

这份是给前端重做用的极简对接版，只保留真正需要接的内容。


## 1. Base URL

当前内网环境直接访问下面这个地址：

```text
http://172.23.9.6:9621
```

前端所有接口都基于这个前缀拼接，不需要再走 `/chat-api/` 代理层。

## 2. 需要对接的接口

### 2.1 流式问答

`POST /query/stream`

请求头：

```http
Content-Type: application/json
Accept: application/x-ndjson
```

建议请求体：

```json
{
  "query": "做梦好不好？",
  "mode": "mix",
  "stream": true,
  "top_k": 12,
  "include_references": true,
  "include_chunk_content": true,
  "conversation_history": [
    { "role": "user", "content": "上一个问题" },
    { "role": "assistant", "content": "上一个回答" }
  ]
}
```

说明：

- `query` 必填，最少 3 个字符
- `mode / top_k / include_references / include_chunk_content` 建议前端内部固定，不要暴露给终端用户
- 如果需要显示引用详情或朗读引用内容，`include_chunk_content` 必须是 `true`

返回是 NDJSON，一行一个 JSON 对象。

典型返回顺序：

1. 第一行：引用资料
2. 后续多行：回答分片
3. 出错时：错误对象

示例：

```ndjson
{"references":[{"reference_id":"1","file_path":"道德经","content":["……"]}]}
{"response":"从修炼的角度来看，"}
{"response":"做梦本身是好的。"}
```

错误示例：

```ndjson
{"error":"LLM service temporarily unavailable"}
```

前端只需要识别三种对象：

```json
{ "references": [...] }
{ "response": "回答分片" }
{ "error": "错误信息" }
```


### 2.2 TTS 朗读

`POST /speech/tts`

请求体最小格式：

```json
{
  "text": "从修炼的角度来看，做梦本身是好的。"
}
```

可选参数：

```json
{
  "text": "……",
  "speaker_id": "xxx",
  "audio_format": "mp3",
  "sample_rate": 24000,
  "speed_ratio": 0.8,
  "volume_ratio": 1.0,
  "pitch_ratio": 1.0
}
```

说明：

- 前端建议只传 `text`
- 音色、语速这类参数建议由后端固定，不要暴露给终端用户

成功时直接返回音频二进制，前端按 `Blob` 播放即可。


### 2.3 ASR 语音输入

`WS /speech/asr/stream`

连接地址示例：

```text
ws://172.23.9.6:9621/speech/asr/stream
```

当前建议的音频规格：

- PCM
- 16kHz
- 16-bit
- mono

交互方式：

1. 建立 WebSocket
2. 等服务端返回：

```json
{ "type": "ready" }
```

3. 持续发送二进制音频分片
4. 停止录音时发送：

```json
{ "type": "end" }
```

服务端识别结果示例：

```json
{
  "type": "transcript",
  "text": "当前识别文本",
  "is_final": false,
  "payload": {}
}
```

最终结果：

```json
{
  "type": "transcript",
  "text": "最终文本",
  "is_final": true,
  "payload": {}
}
```

错误：

```json
{
  "type": "error",
  "message": "Volcengine ASR bridge failed: ..."
}
```


## 3. 引用资料结构

问答接口里 `references` 的单项结构大致如下：

```json
{
  "reference_id": "1",
  "file_path": "道德经",
  "content": ["原文片段1", "原文片段2"],
  "entity_terms": ["清净", "无为"],
  "chunk_order_indices": [0, 1],
  "location_label": "片段 #1-#2 · 第三章",
  "preview": "天下皆知美之为美……",
  "matched_terms": ["清净", "无为"]
}
```

前端真正常用的字段：

- `reference_id`
- `file_path`
- `content`
- `location_label`
- `preview`

注意：

- 正文里的 `[1] [2]` 要和 `reference_id` 对应
- 前端不要自己改引用编号，按后端返回值直接绑定


## 4. 不需要新后端接口的功能

下面这些功能当前都可以前端自己做，不需要后端再补 API：

- 分享
- 复制
- PDF 导出
- 会话历史本地保存


## 6. 最小联调清单

前端接完后，至少测这 6 项：

1. 文本提问，能流式返回回答
2. 回答中的引用编号能正确对应 reference 内容
3. 回答朗读成功
4. 引用资料朗读成功
5. 语音输入识别成功并写回输入框
6. 接口报错时，前端能正确结束 loading 并提示错误
