const ollama = require("ollama").default;

async function test() {
  console.log("Starting...");

  const response = await ollama.generate({
    model: "phi3.5:latest",
    prompt: "Say hello in one sentence.",
  });

  console.log(response.response);
}

test().catch(console.error);