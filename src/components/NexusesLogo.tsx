const LOGO_SRC =
  "https://cdn-nexlink.s3.us-east-2.amazonaws.com/Nexuses-full-logo-dark_8d412ea3-bf11-4fc6-af9c-bee7e51ef494.png";

export function NexusesLogo({
  className = "h-8 w-auto max-w-[160px]",
}: {
  className?: string;
}) {
  return (
    <img
      src={LOGO_SRC}
      alt="Nexuses"
      className={`object-contain object-left ${className}`}
      referrerPolicy="no-referrer"
    />
  );
}
