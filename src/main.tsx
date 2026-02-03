
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner@2.0.3";
import App from "./App.tsx";
import "./index.css";
import "react-day-picker/dist/style.css";

createRoot(document.getElementById("root")!).render(
  <>
    <App />
    <Toaster richColors position="top-center" expand visibleToasts={10} />
  </>
);
  
