import { currentUser } from "@clerk/nextjs/server";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import PianoFallStudio from "./components/PianoFallStudio";

export default async function HomePage() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  const user = await currentUser();
  const email = user?.emailAddresses.find((entry) => entry.id === user.primaryEmailAddressId)?.emailAddress;
  const allowed = process.env.ALLOWED_GOOGLE_EMAIL?.trim().toLowerCase();
  if (!allowed || email?.toLowerCase() !== allowed) redirect("/access-denied");

  return <PianoFallStudio userName={user?.firstName || email || "Piano Fall"} />;
}
