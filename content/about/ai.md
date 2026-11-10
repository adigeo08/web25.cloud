# 🤖 Local AI: a model on your own GPU

The **WebLLM** tab is a chat with a language model that runs entirely in this
browser. [WebLLM](https://webllm.mlc.ai), from the MLC project, executes the
model on your GPU through WebGPU, in a dedicated worker. There is no inference
server, no API key and no account: your questions and the model's answers
never leave the device.

::: feature-grid
- 🖥️ Desktops and laptops run **Llama 3.2 1B** (`q4f32_1`, about 800 MB)
- 📱 Phones and tablets run **Qwen3 0.6B** (`q4f32_1`, about 400 MB), thinking off
- 🔒 Signed-in only; locking the wallet releases the GPU and the conversation
- 📦 Downloaded once on **Install**, then loaded from this browser's cache
- 🧾 The WebLLM library is checked against a pinned SHA-384 before it runs
- 🗂️ Conversations are kept per wallet in IndexedDB, with a retention you choose
- 📚 Optional MDN lookups send only a few search keywords, never the chat
:::

Nothing loads until the tab is opened, and nothing downloads until you press
**Install**. The page asks the GPU for a real adapter and refuses a software
(CPU) one, which would be far too slow; a phone gets a smaller memory profile —
a 2048-token context and 256-token replies, with **Continue →** for more.

Replies can be **Short** or **Thinking** (a plan, then one step at a time, with
earlier steps recalled from a local thought store), or left on **Auto**, where
the model picks. Code it writes can be named and saved to the conversation's
project, previewed and edited — see the code workspace below.
