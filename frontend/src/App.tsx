import { Navigate, Route, Routes } from "react-router-dom";
import Shell from "./components/Shell";
import CatchUpPage from "./pages/CatchUpPage";
import LibraryPage from "./pages/LibraryPage";
import LibrarySettingsPage from "./pages/LibrarySettingsPage";
import NotFound from "./pages/NotFound";

/**
 * Real route components for every address — direct navigation, refresh,
 * back/forward and deep links all work; nothing depends on tab state.
 */
export default function App() {
  return (
    <Routes>
      <Route element={<Shell />}>
        {/* The landing page is the catch-up queue, not a dashboard. */}
        <Route path="/" element={<CatchUpPage />} />
        {/* Old bookmarks and the previous default route. */}
        <Route path="/dashboard" element={<Navigate to="/" replace />} />
        <Route path="/library" element={<LibraryPage />} />
        <Route path="/library/inbox" element={<LibraryPage />} />
        <Route path="/library/category/:categoryId" element={<LibraryPage />} />
        <Route path="/library/tag/:tagId" element={<LibraryPage />} />
        <Route path="/library/item/:postId" element={<LibraryPage />} />
        <Route path="/library/settings" element={<LibrarySettingsPage />} />
        {/* Safe not-found: renders a page, never redirects valid routes away. */}
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
