export function openingStatus(message: string, fileNames: string[]) {
  const csv = fileNames.some((name) => /\.csv$/i.test(name));
  const image = fileNames.some((name) => /\.(png|jpe?g|webp|gif)$/i.test(name));
  if (csv && /attio|list|stage|import|upload/i.test(message)) {
    return "Reading your CSV for Attio…";
  }
  if (csv) return "Reading your CSV…";
  if (image) return "Looking at your image…";
  if (fileNames.length) return "Reading your file…";
  if (/create.*list|list.*stage/i.test(message)) return "Getting ready to set up the list…";
  if (/connect|integrat|api key|apikey/i.test(message)) {
    return "Setting up the connection…";
  }
  if (/attio/i.test(message)) return "Working with Attio…";
  if (/brevo/i.test(message)) return "Working with Brevo…";
  if (/open|click|repl(y|ies)|campaign/i.test(message) && /lemlist|campaign/i.test(message)) {
    return "Looking that up in Lemlist…";
  }
  if (/lemlist/i.test(message)) return "Working with Lemlist…";
  return "Working on it…";
}

export function statusForTool(name: string) {
  const labels: Record<string, string> = {
    connect_integration: "Connecting the API…",
    list_integrations: "Checking connected apps…",
    disconnect_integration: "Disconnecting the API…",
    attio_import_to_list: "Importing contacts into Attio. This can take a little time…",
    attio_create_list: "Creating the list in Attio…",
    attio_list_lists: "Looking up your Attio lists…",
    attio_list_objects: "Checking Attio objects…",
    attio_query_records: "Searching Attio…",
    attio_api: "Updating Attio…",
    brevo_create_contact: "Adding a contact in Brevo…",
    brevo_list_contacts: "Loading Brevo contacts…",
    brevo_list_campaigns: "Loading Brevo campaigns…",
    brevo_api: "Talking to Brevo…",
    lemlist_list_campaigns: "Loading Lemlist campaigns…",
    lemlist_people_by_event: "Collecting people from the campaign…",
    lemlist_list_leads: "Loading Lemlist leads…",
    lemlist_list_activities: "Loading Lemlist activity…",
    lemlist_api: "Talking to Lemlist…",
    custom_api_request: "Calling the connected API…",
  };
  return labels[name] || "Working on the next step…";
}
