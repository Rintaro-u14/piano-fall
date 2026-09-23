import { currentUser } from "@clerk/nextjs/server";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import PianoFallStudio from "./components/PianoFallStudio";

export default async function HomePage() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  const user = await currentUser();
  const email = user?.emailAddresses.find((entry) => entry.id === user.primaryEmailAddressId)?.emailAddress;
  const allowed = [process.env.ALLOWED_GOOGLE_EMAIL, process.env.ALLOWED_GOOGLE_EMAILS]
    .flatMap((value) => value?.split(",") ?? [])
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (!email || !allowed.includes(email.toLowerCase())) redirect("/access-denied");

  return <PianoFallStudio userName={user?.firstName || email || "Piano Fall"} />;
}
