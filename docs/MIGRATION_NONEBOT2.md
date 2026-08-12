# Sakura Plugin 迁移到 NoneBot2 方案

## 概述

将当前 TRSS-Yunzai 的 `sakura-plugin`（Node.js）迁移为 NoneBot2 的 Python 插件，以获得更好的 AI 生态集成（LangChain/LangGraph）和多平台支持。

## 当前架构

```
TRSS-Yunzai (Node.js)
├── NapCat (QQ协议 → OneBot v11)
├── sakura-plugin/
│   ├── apps/chat.js          — 主对话入口
│   ├── lib/AIUtils/
│   │   ├── getAI.js          — LLM 调用（OpenAI SDK）
│   │   ├── tools/            — Function Calling 工具
│   │   │   ├── tools.js      — 工具注册与执行
│   │   │   ├── ComfyUIImageTool.js — 生图
│   │   │   ├── TagSearchTool.js    — RAG 标签检索
│   │   │   └── ...
│   │   ├── imageIntentDetector.js  — 生图意图检测
│   │   ├── imagePromptConfig.js    — 提示词模板
│   │   ├── animaTagRetriever.js    — 关键词检索
│   │   ├── semanticTagSearch.js    — 向量语义检索
│   │   ├── ConversationHistory.js  — Redis 对话记忆
│   │   └── GroupContext.js         — 群聊上下文
│   └── lib/comfyui.js        — ComfyUI API 调用
└── Redis (对话历史存储)
```

## 目标架构

```
NoneBot2 (Python)
├── nonebot-adapter-onebot (连接 NapCat)
├── nonebot-adapter-telegram (可选：扩展到 TG)
├── sakura-nonebot/
│   ├── __init__.py           — 插件入口
│   ├── config.py             — Pydantic 配置
│   ├── matchers.py           — 消息匹配器（对话/指令）
│   ├── ai/
│   │   ├── agent.py          — LangGraph Agent（对话+工具编排）
│   │   ├── tools.py          — LangChain Tools 定义
│   │   ├── memory.py         — 对话记忆（Redis/LangChain Memory）
│   │   ├── rag.py            — RAG 检索（FAISS/ChromaDB）
│   │   └── prompts.py        — 提示词模板
│   ├── comfyui/
│   │   ├── client.py         — ComfyUI API 调用
│   │   ├── workflow.py       — 工作流管理
│   │   └── image_gen.py      — 图片生成逻辑
│   └── utils/
│       ├── group_context.py  — 群聊上下文
│       └── media.py          — 图片/语音处理
└── Redis / ChromaDB
```

## 迁移步骤

### Phase 1: 基础框架搭建（1-2天）

```bash
# 创建项目
pip install nb-cli
nb create -n sakura-bot
cd sakura-bot

# 安装适配器和依赖
pip install nonebot-adapter-onebot
pip install langchain langchain-openai langgraph
pip install chromadb redis faiss-cpu
```

NoneBot2 配置（`.env`）:
```env
DRIVER=~fastapi
ONEBOT_WS_URLS=["ws://localhost:3001"]
```

### Phase 2: 核心对话迁移（2-3天）

**当前 JS 代码：**
```javascript
// apps/chat.js
export class Chat extends plugin {
  constructor() {
    super({ rule: [{ reg: "", fnc: "doChat" }] })
  }
  async doChat(e) {
    const response = await getAI(Channel, e, queryParts, Prompt, GroupContext, Tool, history)
    e.reply(response)
  }
}
```

**迁移后 Python 代码：**
```python
# matchers.py
from nonebot import on_message
from nonebot.adapters.onebot.v11 import MessageEvent
from .ai.agent import chat_agent

chat_matcher = on_message(priority=99)

@chat_matcher.handle()
async def handle_chat(event: MessageEvent):
    response = await chat_agent.invoke(event)
    await chat_matcher.send(response)
```

### Phase 3: AI Agent（LangGraph）（3-5天）

**核心改进：用 LangGraph 实现自动工具编排**

```python
# ai/agent.py
from langgraph.graph import StateGraph, END
from langchain_openai import ChatOpenAI
from .tools import search_tags, generate_image, search_web

# 定义 Agent 状态机
graph = StateGraph(AgentState)
graph.add_node("chat", chat_node)
graph.add_node("search_tags", search_tags_node)
graph.add_node("generate_image", generate_image_node)

# 条件路由：如果需要生图，先搜标签再生图
graph.add_conditional_edges("chat", route_by_intent, {
    "generate_image": "search_tags",  # 强制先搜标签
    "text_reply": END,
})
graph.add_edge("search_tags", "generate_image")
graph.add_edge("generate_image", END)

agent = graph.compile()
```

这样 **searchTags 的调用是架构保证的**，不依赖模型行为。

### Phase 4: RAG 迁移（1-2天）

**当前：手写关键词 + ONNX 向量检索**

**迁移后：ChromaDB + LangChain Retriever**

```python
# ai/rag.py
from langchain_community.vectorstores import Chroma
from langchain_huggingface import HuggingFaceEmbeddings

embeddings = HuggingFaceEmbeddings(model_name="BAAI/bge-small-zh-v1.5")
vectorstore = Chroma(persist_directory="./chroma_db", embedding_function=embeddings)

def search_tags(query: str, top_k: int = 5):
    results = vectorstore.similarity_search(query, k=top_k)
    return results
```

### Phase 5: ComfyUI 生图迁移（1天）

逻辑基本不变，只是从 axios 换成 httpx：

```python
# comfyui/client.py
import httpx

async def generate_image(positive: str, negative: str, workflow: str, **kwargs):
    async with httpx.AsyncClient() as client:
        resp = await client.post(f"{COMFYUI_URL}/prompt", json=payload)
        # ...
```

### Phase 6: 多平台扩展（可选，1天）

```python
# 同时支持 QQ 和 Telegram
# .env
ONEBOT_WS_URLS=["ws://napcat:3001"]
TELEGRAM_BOT_TOKEN="your-token"
```

插件代码**不需要改**——NoneBot2 的适配器层自动处理平台差异。

## 工作量估算

| 阶段 | 内容 | 时间 |
|------|------|------|
| Phase 1 | 框架搭建 | 1-2天 |
| Phase 2 | 核心对话 | 2-3天 |
| Phase 3 | LangGraph Agent | 3-5天 |
| Phase 4 | RAG 迁移 | 1-2天 |
| Phase 5 | ComfyUI | 1天 |
| Phase 6 | 多平台 | 1天 |
| **总计** | | **9-14天** |

## 迁移收益

1. **工具编排可靠性**：LangGraph 状态机保证 searchTags → generateImage 流程
2. **AI 生态**：直接用 LangChain 工具链、向量数据库、Memory 管理
3. **多平台**：一套代码同时服务 QQ + Telegram + Discord
4. **可维护性**：Python 类型系统 + Pydantic 配置验证
5. **社区支持**：NoneBot2 + LangChain 都有活跃社区

## 风险与注意事项

1. **并行运行**：迁移期间可以两套并行，逐步切换
2. **NapCat 不变**：协议层完全不需要改动
3. **Redis 兼容**：对话历史格式可能需要适配
4. **性能**：Python 比 Node.js 慢，但 AI 调用是 IO 密集型，差异不大
5. **依赖管理**：Python 包版本冲突风险（用 poetry 管理）

## 参考资源

- NoneBot2 文档: https://nonebot.dev/
- LangGraph 文档: https://langchain-ai.github.io/langgraph/
- NoneBot2 插件商店: https://nonebot.dev/store
- LangChain Python: https://python.langchain.com/
