-- Up Migration
-- Keeps search_documents current without every write path having to remember: any change to something searchable refreshes that photograph's document.
-- Bulk loaders may set `app.skip_search_refresh = 'on'` for their session/transaction and call refresh_search() once at the end.
CREATE FUNCTION search_touch() RETURNS trigger LANGUAGE plpgsql AS
$$ DECLARE pid uuid; BEGIN
  IF coalesce(current_setting('app.skip_search_refresh', true), '') = 'on' THEN RETURN NULL; END IF;
  IF TG_TABLE_NAME = 'photos' THEN pid := NEW.id;
  ELSIF TG_TABLE_NAME = 'photo_species' THEN pid := NEW.photo_id;
  ELSIF TG_TABLE_NAME = 'photo_versions' THEN pid := NEW.photo_id;
  ELSE SELECT v.photo_id INTO pid FROM photo_versions v WHERE v.id = NEW.photo_version_id;
  END IF;
  IF pid IS NOT NULL THEN PERFORM refresh_search(NEW.user_id, ARRAY[pid]); END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER photos_search AFTER INSERT OR UPDATE OF title, description, notes, trip_location, current_version_id ON photos FOR EACH ROW EXECUTE FUNCTION search_touch();
CREATE TRIGGER photo_species_search AFTER INSERT OR UPDATE OF status ON photo_species FOR EACH ROW EXECUTE FUNCTION search_touch();
CREATE TRIGGER ai_analyses_search AFTER INSERT ON ai_analyses FOR EACH ROW EXECUTE FUNCTION search_touch();
CREATE TRIGGER photo_versions_search AFTER INSERT OR UPDATE OF keywords, source_relpath, photo_id ON photo_versions FOR EACH ROW EXECUTE FUNCTION search_touch();

-- Down Migration
DROP TRIGGER photo_versions_search ON photo_versions;
DROP TRIGGER ai_analyses_search ON ai_analyses;
DROP TRIGGER photo_species_search ON photo_species;
DROP TRIGGER photos_search ON photos;
DROP FUNCTION search_touch();
