// Next.js API route support: https://nextjs.org/docs/api-routes/introduction
import { db } from "@/config/db";
import { getCurrentUser } from "@/handlers/serverUtils/user.utils";
import { assetFaces, person } from "@/schema";
import { faceSearch } from "@/schema/faceSearch.schema";
import { and, asc, cosineDistance, desc, eq, gt, ne, sql } from "drizzle-orm";
import type { NextApiRequest, NextApiResponse } from "next";

type ISortField = "assetCount" | "updatedAt" | "createdAt";

interface IQuery {
  id: string;
  page: number;
  perPage: number;
  name: "nameless" | "tagged" | "all";
  minimumAssetCount: number;
  sort: ISortField;
  sortOrder: "asc" | "desc";
  threshold?: number; 
}
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  try {
    const {
      id,
      threshold = 0.5, 
      name,
      perPage = 50,
    } = req.query as any as IQuery;

    const thresholdNum = Number(threshold) || 0.5;
    const limit = Math.min(Math.max(Number(perPage) || 50, 1), 200);

    const currentUser = await getCurrentUser(req);
    const personRecords = await db
      .select()
      .from(person)
      .where(eq(person.id, id))
      .limit(1);

    const personRecord = personRecords?.[0];
    if (!personRecord) {
      return res.status(404).json({
        error: "Person not found",
      });
    }

    // Use the person's representative face (faceAssetId) for deterministic results.
    // Fall back to the first face ordered by ID if faceAssetId is not set.
    let faceSearchRecord;

    if (personRecord.faceAssetId) {
      const records = await db
        .select()
        .from(faceSearch)
        .where(eq(faceSearch.faceId, personRecord.faceAssetId))
        .limit(1);
      faceSearchRecord = records?.[0];
    }

    if (!faceSearchRecord) {
      const records = await db
        .select({
          faceId: faceSearch.faceId,
          embedding: faceSearch.embedding,
        })
        .from(faceSearch)
        .innerJoin(assetFaces, eq(assetFaces.id, faceSearch.faceId))
        .where(eq(assetFaces.personId, personRecord.id))
        .orderBy(asc(faceSearch.faceId))
        .limit(1);
      faceSearchRecord = records?.[0];
    }

    if (!faceSearchRecord) {
      return res.status(404).json({
        error: "No similar faces found",
      });
    }

    const similarity = sql<number>`1 - (${cosineDistance(
      faceSearch.embedding,
      faceSearchRecord.embedding
    )})`;

    // Build name filter for SQL (instead of post-query filtering)
    const nameFilter =
      name === "nameless" ? eq(person.name, "")
      : name === "tagged" ? ne(person.name, "")
      : undefined;

    // Use DISTINCT ON with proper ORDER BY to get the best match per person.
    // PostgreSQL requires DISTINCT ON columns to be the leading ORDER BY columns,
    // so we sort by person.id first (for DISTINCT ON), then similarity DESC
    // (so the highest-similarity face is kept for each person).
    const people = await db
      .selectDistinctOn([person.id], {
        id: person.id,
        name: person.name,
        birthDate: person.birthDate,
        isHidden: person.isHidden,
        updatedAt: person.updatedAt,
        assetId: assetFaces.id,
        faceSearch: faceSearch.faceId,
        similarity,
      })
      .from(faceSearch)
      .leftJoin(assetFaces, eq(assetFaces.id, faceSearch.faceId))
      .innerJoin(person, eq(person.id, assetFaces.personId))
      .where(
        and(
          ne(person.id, id),
          eq(person.ownerId, currentUser.id),
          gt(similarity, thresholdNum),
          nameFilter,
        )
      )
      .orderBy(person.id, desc(similarity))
      .limit(limit);

    // Sort results by similarity descending (can't do it in SQL with DISTINCT ON
    // because PostgreSQL requires DISTINCT ON columns as leading ORDER BY columns)
    people.sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));

    return res.status(200).json(people);
  } catch (error: any) {
    res.status(500).json({
      error: error?.message,
    });
  }
}
