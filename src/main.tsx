import { definePlugin } from "@daily/plugin-sdk";
import { startBackgroundWorker } from "./worker/BackgroundWorker";
import { setView } from "./view";

export default definePlugin({
  activate: () => startBackgroundWorker(),
  views: {
    "writer.workbench": {
      async mount(container, view) {
        const [{ createRoot }, { styles }, { WriterApp }] = await Promise.all([
          import("react-dom/client"), import("./styles"), import("./ui/App"),
        ]);
        if (view.signal.aborted) return;
        view.addStyles(styles);
        setView(view, container);
        const root = createRoot(container);
        root.render(<WriterApp />);
        return () => { root.unmount(); setView(null); };
      },
    },
  },
});
