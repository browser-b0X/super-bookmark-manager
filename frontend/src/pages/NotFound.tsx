import { Link } from "react-router-dom";
import { Compass } from "lucide-react";

export default function NotFound() {
  return (
    <div className="mx-auto mt-[16vh] max-w-[420px] text-center">
      <Compass size={28} className="mx-auto text-[var(--faint)]" />
      <h1 className="mt-3 text-[1.05rem] font-semibold">Page not found</h1>
      <p className="mt-1 text-[.8rem] text-[var(--dim)]">
        This address doesn't match any dashboard or library route.
      </p>
      <div className="mt-4 flex justify-center gap-2">
        <Link className="btn btn-primary" to="/dashboard">Dashboard</Link>
        <Link className="btn" to="/library">Library</Link>
      </div>
    </div>
  );
}
