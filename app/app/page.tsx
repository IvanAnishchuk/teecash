import Link from "next/link";

export default function Home() {
  return (
    <main>
      <h1>teecash</h1>
      <p className="sub">The wallet screens are not built yet.</p>
      <Link href="/debug">Run the risk screen</Link>
    </main>
  );
}
