/**
 * 图片生成提示词配置
 * 集中管理所有与图片生成相关的 AI 提示词，方便统一修改
 */

/** 主 AI 工具描述 - 简洁版，告诉 AI 何时调用工具 */
export const TOOL_DESCRIPTION = "生成图片。支持动漫二次元(anima)和写实真人(krea2)两种风格。当聊天中有生图意图时使用。如果用户发送/引用了参考图片或@了某人（用其头像作参考），设置 hasReferenceImage=true 使用风格参考模式。"

/** tags 参数描述 - 指导 AI 如何写 prompt */
export const TAGS_DESCRIPTION = `画面描述，必须使用英文。根据选择的模型使用不同格式：

【使用 Anima 模型时（style=anime/anima）】使用 Danbooru 标签，英文逗号分隔：
- 必须包含人物数量标签：1girl / 2girls / 1boy / no humans 等
- 如果不是画「我自己」，需包含完整外貌描述（发色、发型、瞳色、服装等）
- 示例: "1girl, long white hair, blue eyes, kimono, standing, smile, cherry blossoms, outdoor"
- 示例: "1boy, black hair, hoodie, gaming chair, playing video games, monitor glow"

【使用 Krea-2 模型时（style=krea2/k2/realistic）】基于 Flux 引擎，必须用流畅散文式英文描述：
写法规则（严格遵守）：
1. 主体放最前面（模型对开头权重最大）
2. 写成给画师的指令，像导演指导摄影一样具体
3. 结构：主体+姿势动作 → 场景环境 → 构图视角 → 光线 → 风格/介质
4. 30-80 词最佳长度，每个词都应该能改变画面
5. 不要用质量标签（masterpiece/8k/best quality 等无效）
6. 不要用逗号标签列表，写完整句子
7. 命名具体效果（如 "Rembrandt lighting"、"85mm lens"、"f/1.4 bokeh"）
8. 动漫风格时加 "The whole scene drawn as 2D anime illustration with cel shading"
9. NSFW 场景使用准确解剖学词汇，不回避不委婉化

具体描述要求：
- 身体：哪个部位在哪里、什么姿势、四肢怎么放、重心在哪
- 视角：shot type (full-body/medium close-up/extreme close-up)、camera angle (eye-level/low angle/high angle)
- 服装：穿着状态、哪里敞开、面料质感
- 表情：用可视化描述（half-closed eyes, parted lips, flushed cheeks），不用情绪词（showing pleasure）
- 光线：方向、色温、类型（rim light/soft diffused/dramatic side lighting）

示例（写实人像）:
"A Japanese woman in her 20s sitting sideways on a wooden chair, right leg crossed over left, wearing an oversized cream sweater that slips off her left shoulder, chin tilted up, soft afternoon sunlight from a window on the right casting warm highlights on her collarbone, 85mm lens, shallow depth of field, eye-level shot"

示例（动漫）:
"The whole scene drawn as 2D anime illustration with cel shading. A girl with long pink twin-tails sitting on a school chair backwards, arms folded on the backrest, chin resting on her arms, looking up at the viewer with half-closed eyes, wearing a loose white shirt with top button undone, soft classroom lighting from the left"

示例（NSFW）:
"A woman lying on her back on white bedsheets, left knee bent upward, right arm draped above her head, completely nude, small breasts with pink nipples visible, soft warm lamplight from the left side, medium close-up shot from above at 45 degrees, photorealistic skin texture with visible pores"

【有参考图时（hasReferenceImage=true）】同样用散文式描述，描述想在参考图风格基础上生成的画面：
- 示例: "A boy sitting at a gaming desk playing video games, wearing a gaming headset, LED lights in the background, same artistic style as the reference"
- 示例: "Full-body portrait of the same person in a different setting, standing on a rooftop at sunset, wind blowing through hair"`

/** style 参数描述 */
export const STYLE_DESCRIPTION = `选择使用的模型/风格。优先级：用户明确指定模型 > 根据内容推断。
- krea2 / k2 = 使用 Krea-2 模型（用户明确说"krea2""k2"时选此项，支持写实和动漫）
- anima = 使用 Anima 模型（用户明确说"anima"时选此项）
- realistic = 使用 Krea-2 模型（用户说"写实""真人""照片"时选此项）
- anime = 使用 Anima 模型（用户说"动漫""二次元""插画"或未指定时默认此项）

判断逻辑：先看用户是否指定了模型名（krea2/k2/anima），再看描述的风格（写实/动漫）。`

/** imageIntentDetector 专用系统提示词 */
export const IMAGE_INTENT_SYSTEM_PROMPT = `你是一个图片生成意图检测器。根据对话上下文，判断用户是否有想看到图片的意图。
如果有，调用 generateImage 工具生成图片。如果没有，什么都不做直接回复"无需生图"。

调用规则：
- tags：根据情况使用不同格式：
  · anime风格（无参考图）：Danbooru 标签（英文逗号分隔），包含人物数量标签(1girl/2girls等)
    示例: "1girl, bare legs, thighs, sitting, looking at viewer, close-up"
  · realistic/krea2风格（无参考图）：英文自然语言描述
    示例: "A photorealistic portrait of a woman sitting on a park bench, soft natural lighting"
  · 有参考图时（hasReferenceImage=true）：必须使用英文自然语言完整句子描述想要的画面
    示例: "A boy playing video games at his gaming desk, wearing a headset, colorful LED lighting in the room"
- style：选择使用的模型（用户指定优先）
  · krea2 / k2 — 用户明确说"krea2""k2"时（支持任何风格，写实和动漫都行）
  · anima — 用户明确说"anima"时
  · realistic — 用户说"写实""真人""照片风格"时（使用 Krea-2 模型）
  · anime — 用户说"动漫""二次元""插画"或未指定时（默认，使用 Anima 模型）
  · 判断逻辑：先看是否指定模型名（krea2/k2/anima），再看描述风格
- includeSelf：画「当前对话角色自己」时设为true；画其他角色/物体/风景设为false。
- orientation：portrait/landscape/square
- hasReferenceImage：用户是否发送或引用了图片作为参考。如果消息中有图片则设为true。
  注意：有参考图时 tags 必须是自然语言描述，不能用逗号分隔的标签！

示例：
- 用户说"看看腿" → style:"anime", includeSelf:true, tags:"1girl, bare legs, thighs, sitting, looking at viewer, close-up"
- 用户说"画一只知更鸟" → style:"anime", includeSelf:false, tags:"no humans, robin (bird), perched, branch, nature, blue feathers"
- 用户说"用krea2画风景照" → style:"realistic", includeSelf:false, tags:"Breathtaking mountain landscape with a crystal clear lake reflecting the sunset, golden hour lighting"
- 用户发送图片说"参考这个风格画个男生打游戏" → hasReferenceImage:true, tags:"A boy sitting at a gaming desk playing video games, wearing a gaming headset, LED lights in the background"
- 用户@某人说"参考他的头像画一张" → hasReferenceImage:true, tags:"A portrait in the style of the reference image, detailed face, soft lighting"

以下情况应该生图：
- 用户明确要求画画、看图、看某个场景
- 用户描述了想看的画面（如"看看腿"、"穿泳装"、"比个心"等）
- 对话语境中有明显的视觉画面暗示

以下情况不生图：
- 普通闲聊没有视觉相关内容
- 用户在讨论非画面相关话题
- 已经在同一轮对话中生成过图片`
