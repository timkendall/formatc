try { null!.x; } catch (e) { console.log(e instanceof TypeError); }
try { JSON.parse("{"); } catch (e) { console.log((e as Error).name); }
