export interface R18Actress {
  id: number;
  name_kanji?: string;
  name_kana?: string;
  name_romaji?: string;
  image_url?: string;
}

export interface R18Director {
  id: number;
  name_kanji?: string;
  name_kana?: string;
  name_romaji?: string;
}

export interface R18Category {
  id: number;
  name_ja?: string;
  name_en?: string;
}

export interface R18MovieDetailResponse {
  content_id: string;
  dvd_id?: string | null;
  title_ja?: string;
  title_en?: string;
  release_date?: string;
  runtime_mins?: number;
  maker_id?: number;
  maker_name_ja?: string;
  maker_name_en?: string;
  label_id?: number;
  label_name_ja?: string;
  label_name_en?: string;
  series_id?: number;
  series_name_ja?: string;
  series_name_en?: string;
  actresses?: R18Actress[];
  directors?: R18Director[];
  categories?: R18Category[];
  sample_url?: string;
  jacket_full_url?: string;
  jacket_thumb_url?: string;
}
