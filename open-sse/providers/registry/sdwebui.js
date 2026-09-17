export default {
  id: "sdwebui",
  priority: 110,
  alias: "sdwebui",
  display: {
    name: "SD WebUI",
    icon: "brush",
    color: "#FF7043",
    textIcon: "SD",
    website: "https://github.com/AUTOMATIC1111/stable-diffusion-webui",
  },
  category: "apikey",
  transport: null,
  models: [
    { id: "sdxl-lightning-4step", name: "SDXL Lightning 4-step", params: ["n","size","seed"], kind: "image", local: true, estimated_cost_usd: 0, role: "local_standard" },
    { id: "stable-diffusion-v1-5", name: "Stable Diffusion v1.5", params: ["n","size","seed"], kind: "image", local: true, estimated_cost_usd: 0, role: "local_standard" },
    { id: "sdxl-base-1.0", name: "SDXL Base 1.0", params: ["n","size","seed"], kind: "image", local: true, estimated_cost_usd: 0, role: "local_standard" },
  ],
  serviceKinds: ["image"],
  imageConfig: { baseUrl: "http://localhost:7860/sdapi/v1/txt2img", healthUrl: "http://localhost:7860/sdapi/v1/sd-models" },
};
