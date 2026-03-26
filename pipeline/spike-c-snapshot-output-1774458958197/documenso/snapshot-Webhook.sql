--
-- PostgreSQL database dump
--

-- Dumped from database version 15.17 (Debian 15.17-1.pgdg13+1)
-- Dumped by pg_dump version 16.9 (Homebrew)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Data for Name: Webhook; Type: TABLE DATA; Schema: public; Owner: documenso
--

INSERT INTO public."Webhook" VALUES ('21883519-f673-4e22-94ce-c465afce15c2', 'http://127.0.0.1:8080/webhook', NULL, 'test-secret', true, '2026-03-25 17:00:09.631', '2026-03-25 17:00:09.631', 9, 7);
INSERT INTO public."Webhook" VALUES ('40113eec-29bb-4ab7-a6e6-fe5db3e7c4fb', 'http://127.0.0.1:8080/webhook', NULL, 'test-secret', true, '2026-03-25 17:00:14.31', '2026-03-25 17:00:14.31', 9, 7);


--
-- PostgreSQL database dump complete
--

