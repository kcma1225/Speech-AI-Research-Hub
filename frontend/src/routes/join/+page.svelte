<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";

  // Older invitation links used /join?token=…; the join form lives at /join/<token>.
  $effect(() => {
    const token = page.url.searchParams.get("token");
    void goto(token ? `/join/${encodeURIComponent(token)}` : "/login", { replace: true });
  });
</script>
