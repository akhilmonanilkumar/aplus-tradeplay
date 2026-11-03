import Link from "next/link";

export default function NotFound() {
  return (
    <section className="card" style={{ maxWidth: 520, margin: "48px auto" }}>
      <div className="ch"><h3>Page not found</h3></div>
      <p className="muted" style={{ fontSize: 13 }}>This page does not exist or has moved in the new layout.</p>
      <div className="row" style={{ marginTop: 12 }}><Link className="btn pri sm" href="/">Go to the dashboard</Link></div>
    </section>
  );
}
