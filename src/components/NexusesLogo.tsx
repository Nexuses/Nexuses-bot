import { NEXUSES_LOGO_URL } from "@/lib/brand";

export { NEXUSES_LOGO_URL };

export function NexusesLogo({
  className = "h-8 w-auto max-w-[160px]",
}: {
  className?: string;
}) {
  return (
    <img
      src={NEXUSES_LOGO_URL}
      alt="Nexuses"
      className={`object-contain object-left ${className}`}
      referrerPolicy="no-referrer"
    />
  );
}
