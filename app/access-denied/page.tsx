import { SignOutButton } from "@clerk/nextjs";

export default function AccessDeniedPage() {
  return (
    <main className="auth-page">
      <div className="auth-card">
        <span className="brand-mark">▥</span>
        <p className="eyebrow">PIANO FALL</p>
        <h1>このアカウントは利用できません</h1>
        <p>登録されたGoogleアカウントでログインしてください。</p>
        <SignOutButton>
          <button className="primary-button">ログアウト</button>
        </SignOutButton>
      </div>
    </main>
  );
}
