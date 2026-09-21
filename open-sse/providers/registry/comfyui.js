export default {
  id: "comfyui",
  priority: 120,
  alias: "comfyui",
  display: {
    name: "ComfyUI",
    icon: "account_tree",
    color: "#4CAF50",
    textIcon: "CF",
    website: "https://github.com/comfyanonymous/ComfyUI",
  },
  category: "apikey",
  transport: null,
  models: [
    { id: "local-fast-image", name: "Local Fast Image (role)", params: ["n","size","seed","workflow"], kind: "image", local: true, estimated_cost_usd: 0, role: "local_fast" },
    { id: "local-quality-image", name: "Local Quality Image (role)", params: ["n","size","seed","workflow"], kind: "image", local: true, estimated_cost_usd: 0, role: "local_quality" },
    { id: "local-edit-image", name: "Local Edit Image (role)", params: ["n","size","seed","workflow"], kind: "image", local: true, estimated_cost_usd: 0, role: "local_edit" },
    { id: "sdxl-lightning-4step", name: "SDXL Lightning 4-step", params: ["n","size","seed","workflow"], kind: "image", local: true, estimated_cost_usd: 0, role: "local_standard" },
    { id: "flux-dev", name: "FLUX Dev", params: ["n","size","workflow"], kind: "image", local: true, estimated_cost_usd: 0, role: "local_standard" },
  ],
  serviceKinds: ["image"],
  imageConfig: { baseUrl: "http://localhost:8188", healthUrl: "http://localhost:8188/system_stats" },
};
