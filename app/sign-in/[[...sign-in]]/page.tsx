"use client";

import { useSignIn } from "@clerk/nextjs";
import { useState } from "react";

function GoogleOnlySignIn() {
  const { fetchStatus, signIn } = useSignIn();
  const [error, setError] = useState("");

  async function continueWithGoogle() {
    if (fetchStatus === "fetching") return;
    setError("");
    try {
      const result = await signIn.sso({
        strategy: "oauth_google",
        redirectUrl: "/sign-in/sso-callback",
        redirectCallbackUrl: "/sign-in/sso-callback",
      });
      if (result.error) setError(result.error.message);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Googleログインを開始できませんでした。");
    }
  }

  return (
    <div className="auth-card">
      <span className="brand-mark">▥</span>
      <p className="eyebrow">PIANO FALL</p>
      <h1>音を、眺めよう。</h1>
      <p>登録されたGoogleアカウントでログインしてください。</p>
      <button className="primary-button full google-button" disabled={fetchStatus === "fetching"} onClick={() => void continueWithGoogle()}>G&nbsp;&nbsp; Googleで続ける</button>
      {error && <p className="auth-error">{error}</p>}
      <small className="auth-note">このアプリはGoogleログインのみを使用します。</small>
    </div>
  );
}

export default function SignInPage() {
  return (
    <main className="auth-page">
      <div className="auth-brand"><span className="brand-mark">▥</span><span>PIANO FALL</span></div>
      <GoogleOnlySignIn />
    </main>
  );
}
