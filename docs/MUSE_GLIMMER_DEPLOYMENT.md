# Muse Glimmer 30B 部署与转换指南

## 模型信息

| 项目 | 说明 |
|------|------|
| 来源 | Meta Superintelligence Lab，2026年8月发布 |
| 许可 | Apache 2.0 |
| 参数量 | ~29.6B（含 1.8B ViT-G/14 视觉编码器） |
| 架构 | Dense Causal Transformer + Perception Encoder |
| 特长 | 工具调用、多步推理、多模态理解、故障恢复 |
| 上下文窗口 | 131,072 tokens |
| 视觉支持 | 支持交错文本+图片输入，每张图最多 4,096 视觉 token |

## 部署环境

- 服务器：带 GPU 的 Linux（用户环境为多卡）
- Ollama：v0.32.9+
- 模型存储路径：`/opt/ai-pro/ollama_models/`
- Ollama 环境变量：`/etc/ollama/env`
- HuggingFace 模型下载路径：`/data/hf_models/`

## 操作记录

### 1. 确认 Ollama 官方版本不支持 NSFW

Ollama 官方 `muse-glimmer:30b-bf16-dflash` 通过 Modelfile 修改 SYSTEM prompt 无法绕过审查。模型的拒绝行为是权重级的（RLHF 训练），非 prompt 级。

### 2. 找到社区去审查版本

- [darkc0de/Muse-Glimmer-30B-heretic](https://huggingface.co/darkc0de/Muse-Glimmer-30B-heretic) — Heretic v1.4.0 去审查
- 该版本只有 safetensors 格式，无 GGUF

### 3. 下载 safetensors 到服务器

```bash
# 设置 HF 镜像（如果直连不了）
export HF_ENDPOINT=https://hf-mirror.com

# 关闭离线模式
unset HF_HUB_OFFLINE

# 下载到指定目录
hf download darkc0de/Muse-Glimmer-30B-heretic \
  --local-dir /data/hf_models/Muse-Glimmer-30B-heretic
```

> 注意：模型约 58GB（BF16 全精度）

### 4. 转换 safetensors → GGUF

Ollama 不直接支持 `MuseGlimmerForConditionalGeneration` 架构的 safetensors 导入（`ollama create` 报错 `unsupported architecture`）。需要用 llama.cpp 的转换脚本。

#### 4.1 准备 llama.cpp 环境

```bash
# 克隆 llama.cpp（如果没有）
git clone https://github.com/ggml-org/llama.cpp.git /tmp/llama-cpp

# 创建 conda 环境（推荐独立环境）
conda create -n gguf-convert python=3.10 -y
conda activate gguf-convert

# 安装依赖
pip install torch transformers sentencepiece protobuf numpy gguf
```

#### 4.2 执行转换（仅语言模型）

```bash
python /tmp/llama-cpp/convert_hf_to_gguf.py \
  /data/hf_models/Muse-Glimmer-30B-heretic \
  --outtype bf16 \
  --outfile /data/hf_models/muse-glimmer-heretic-bf16.gguf
```

> 输出文件约 58GB，耗时取决于磁盘速度

#### 4.3 转换视觉投影（mmproj）— 启用多模态

llama.cpp 自 `b10353` 版本起完整支持 Muse Glimmer（PR #26841，2026-08-10 合并）。

**方法 A：直接下载 Meta 官方 mmproj（推荐）**

视觉编码器是冻结的（heretic 只修改了语言模型权重），可以直接用官方 mmproj：

```bash
export HF_ENDPOINT=https://hf-mirror.com
hf download meta-models/Muse-Glimmer-30B-GGUF \
  --include "mmproj-Muse-Glimmer-30B-Q4_K_M.gguf" \
  --local-dir /data/hf_models/
```

> mmproj 文件仅 1.4GB（Q4_K_M 量化）

**方法 B：从 safetensors 自行转换**

需要 llama.cpp `b10353` 或更新版本：

```bash
cd /tmp/llama-cpp && git pull  # 确保最新

python /tmp/llama-cpp/convert_hf_to_gguf.py \
  /data/hf_models/Muse-Glimmer-30B-heretic \
  --mmproj \
  --outfile /data/hf_models/mmproj-muse-glimmer-heretic.gguf
```

### 5. 导入 Ollama

#### 5.1 仅语言模型（当前使用的方式）

```bash
# 创建 Modelfile
cat > /home/modefile/muse-glimmer-heretic <<'EOF'
FROM /data/hf_models/muse-glimmer-heretic-bf16.gguf
EOF

# 创建 Ollama 模型
ollama create muse-glimmer-heretic:30b -f /home/modefile/muse-glimmer-heretic
```

#### 5.2 带视觉支持（Ollama 双 FROM 方式）

```bash
# Modelfile 使用两个 FROM（需要 Ollama 支持 muse-glimmer 架构）
cat > /home/modefile/muse-glimmer-heretic-vision <<'EOF'
FROM /data/hf_models/muse-glimmer-heretic-bf16.gguf
FROM /data/hf_models/mmproj-Muse-Glimmer-30B-Q4_K_M.gguf
EOF

ollama create muse-glimmer-heretic:30b-vision -f /home/modefile/muse-glimmer-heretic-vision
```

> 如果 Ollama 报错不支持架构，使用下面的 llama-server 方式。

#### 5.3 带视觉支持（llama-server 方式，最可靠）

```bash
# 确保 llama.cpp 版本 >= b10353
cd /tmp/llama-cpp && git pull

# 编译（需要 CUDA）
mkdir -p build && cd build
cmake .. -DGGML_CUDA=ON && cmake --build . -j$(nproc)

# 启动带视觉的推理服务（OpenAI 兼容 API）
./bin/llama-server \
  -m /data/hf_models/muse-glimmer-heretic-bf16.gguf \
  --mmproj /data/hf_models/mmproj-Muse-Glimmer-30B-Q4_K_M.gguf \
  -ngl 99 -c 32768 \
  --host 0.0.0.0 --port 11434 \
  --jinja \
  --temp 1.0 --top-p 0.95 --top-k 64
```

> llama-server 提供 OpenAI 兼容 API（`/v1/chat/completions`），可直接替代 Ollama。
> 只需将渠道配置的 baseURL 改为 `http://服务器IP:11434/v1` 即可。

### 6. 验证模型

```bash
# 查看模型信息
ollama show muse-glimmer-heretic:30b

# 测试工具调用
ollama run muse-glimmer-heretic:30b "请调用 searchTags 搜索御坂美琴的标签"

# 测试 NSFW（heretic 版本应该可以）
ollama run muse-glimmer-heretic:30b "写一段成人向的描写"
```

### 7. 发布到 HuggingFace（可选）

#### 7.1 SSH 方式配置

```bash
# 测试 SSH 连接
ssh -T git@hf.co
# 应显示: Hi sun99yue, ...

# 创建仓库
unset HF_ENDPOINT  # 必须关闭镜像
huggingface-cli repo create Muse-Glimmer-30B-heretic-BF16-GGUF --type model

# 克隆并推送
git clone git@hf.co:sun99yue/Muse-Glimmer-30B-heretic-BF16-GGUF
cd Muse-Glimmer-30B-heretic-BF16-GGUF

# 安装 git-lfs
git lfs install
git lfs track "*.gguf"
git add .gitattributes
git commit -m "init lfs"

# 添加大文件（会很慢）
cp /data/hf_models/muse-glimmer-heretic-bf16.gguf .
git add muse-glimmer-heretic-bf16.gguf
git commit -m "add bf16 gguf"
git push origin main
```

> 注意：发布到 HuggingFace 需要关闭 `HF_ENDPOINT` 镜像设置，使用原始域名。
> 大文件通过 Git LFS 上传，网络要求较高。

## Conda 环境管理

```bash
# 查看已有环境
conda env list

# 激活转换环境
conda activate gguf-convert

# 环境中已安装的包
# torch, transformers, sentencepiece, protobuf, numpy, gguf
```

## 常见问题

### Q: `ollama create` 报 `unsupported architecture "MuseGlimmerForConditionalGeneration"`
A: Ollama 不能直接从 safetensors 导入该架构。必须先用 `convert_hf_to_gguf.py` 转为 GGUF。

### Q: 模型不支持图片输入（`image input is not supported - mmproj`）
A: 转换时只转了语言模型，没有视觉投影。需要用 `--mmproj` 单独转换，或在代码中自动降级剥离图片（已实现）。

### Q: Modelfile 方式能否绕过审查？
A: 不能。Muse Glimmer 的审查是权重级（RLHF），需要 abliteration 或使用社区 heretic 版本。

### Q: Ollama pull `30b-bf16-dflash` 一直 EOF？
A: 清理 partial 文件后重试：
```bash
find /opt/ai-pro/ollama_models/blobs/ -name "*partial*" -delete
systemctl restart ollama
ollama pull muse-glimmer:30b-bf16-dflash
```

### Q: 升级 Ollama 后旧模型消失？
A: 检查 service 文件中 `EnvironmentFile=/etc/ollama/env` 是否被覆盖。升级可能替换了 systemd service 文件。
